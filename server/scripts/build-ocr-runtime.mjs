import { nodeFileTrace } from '@vercel/nft';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, '.ocr-runtime');
const staging = path.join(root, '.ocr-runtime.build');
// Restrict recursive cleanup to these two generated directories in the service.
for (const folder of [destination, staging]) {
  if (path.dirname(folder) !== root || !/^\.ocr-runtime(?:\.build)?$/.test(path.basename(folder))) throw new Error('Invalid OCR build directory');
}
const require = createRequire(path.join(root, 'package.json'));
const workers = ['lib/ocr/paddleWorker.js', 'lib/ocr/tesseractWorker.js', 'lib/pdfRender.js'];
const innerTesseract = path.relative(root, require.resolve('tesseract.js/src/worker-script/node/index.js'));
const { fileList } = await nodeFileTrace([...workers, innerTesseract].map(file => path.join(root, file)), {
  base: root, processCwd: root, ignore: ['.ocr-runtime/**', '.ocr-runtime.build/**'],
});
const files = new Set([...fileList].map(file => file.replaceAll('\\', '/'))
  .filter(file => !/^\.ocr-runtime(?:\.build)?\//.test(file)));

async function includeDirectory(relative) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await includeDirectory(file);
    else files.add(file);
  }
}
// These assets are selected by path at runtime, outside static import tracing.
await includeDirectory('node_modules/@gutenye/ocr-models/assets');
await includeDirectory('node_modules/tesseract.js-core');
await includeDirectory('node_modules/pdfjs-dist/standard_fonts');
await includeDirectory('node_modules/pdfjs-dist/cmaps');
files.add('data/tessdata/eng.traineddata');

function nativePlatformMatches(file) {
  const onnx = file.match(/node_modules\/onnxruntime-node\/bin\/napi-v\d+\/([^/]+)\/([^/]+)\//);
  if (onnx) return onnx[1] === process.platform && onnx[2] === process.arch;
  const optional = file.match(/node_modules\/(?:@napi-rs\/canvas-|@img\/sharp-(?:libvips-)?)([^/]+)\//);
  return !optional || optional[1].startsWith(`${process.platform}-${process.arch}`);
}

await rm(staging, { recursive: true, force: true });
let bytes = 0;
let count = 0;
const copied = [];
for (const file of [...files].sort()) {
  if (file.startsWith('../') || path.isAbsolute(file) || /(^|\/)\.env(?:\.|$)/.test(file)) throw new Error('OCR trace escaped the service root');
  if (!nativePlatformMatches(file)) continue;
  const source = path.join(root, file);
  if (!(await stat(source)).isFile()) continue;
  const target = path.join(staging, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  bytes += (await stat(source)).size;
  count++;
  copied.push(file);
}
// Make every worker asset visible to the framework's static file trace. This
// function is never called: importing the module does not read model bytes.
const traceSource = 'const { readFileSync } = require("node:fs");\nconst { join } = require("node:path");\nexports.traceAssets = function () {\n' +
  copied.map(file => `  readFileSync(join(__dirname, ${JSON.stringify(file)}));`).join('\n') + '\n};\n';
await writeFile(path.join(staging, 'trace-assets.cjs'), traceSource);
await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, files: count, bytes }));
await rm(destination, { recursive: true, force: true });
await rename(staging, destination);
console.log(`[OCR build] ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${process.platform}/${process.arch}`);

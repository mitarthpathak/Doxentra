// Pixel comparison of two screenshot folders (e.g. docs/baseline vs docs/current).
// Usage: node scripts/compare.mjs docs/baseline docs/current [ignoreTopPx]
// Writes diff images (changed pixels in red) next to the current screenshots
// and prints the share of changed pixels per screen. The top bar can be
// excluded (default 64 px) because it gained the new navigation entries.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { loadChromium } from './lib/browser.mjs';

const [a = 'docs/baseline', b = 'docs/current', ignoreTop = '64'] = process.argv.slice(2);
const chromium = await loadChromium();
const browser = await chromium.launch();
const page = await browser.newPage();
const rows = [];
for (const name of readdirSync(a).filter(f => f.endsWith('.png') && !f.startsWith('diff-'))) {
  if (!existsSync(`${b}/${name}`)) {
    rows.push({ name, result: 'missing in current' });
    continue;
  }
  const res = await page.evaluate(async ([x, y, top]) => {
    const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    const w = Math.max(ia.width, ib.width);
    const h = Math.max(ia.height, ib.height);
    const read = img => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const da = read(ia);
    const db = read(ib);
    const out = new OffscreenCanvas(w, h);
    const g = out.getContext('2d');
    g.globalAlpha = 0.25;
    g.drawImage(ib, 0, 0);
    g.globalAlpha = 1;
    const diff = g.getImageData(0, 0, w, h);
    let changed = 0;
    let counted = 0;
    for (let yy = top; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4;
        counted++;
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 30) {
          changed++;
          diff.data.set([255, 0, 0, 255], i);
        }
      }
    }
    g.putImageData(diff, 0, 0);
    const blob = await out.convertToBlob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const v of bytes) bin += String.fromCharCode(v);
    return { sizeA: `${ia.width}x${ia.height}`, sizeB: `${ib.width}x${ib.height}`, changed: changed / counted, png: btoa(bin) };
  }, [`data:image/png;base64,${readFileSync(`${a}/${name}`).toString('base64')}`, `data:image/png;base64,${readFileSync(`${b}/${name}`).toString('base64')}`, Number(ignoreTop)]);
  writeFileSync(`${b}/diff-${name}`, Buffer.from(res.png, 'base64'));
  rows.push({ name, result: `${(res.changed * 100).toFixed(2)}% changed`, size: res.sizeA === res.sizeB ? res.sizeA : `${res.sizeA} -> ${res.sizeB}` });
}
await browser.close();
for (const r of rows) console.log(`${r.name.padEnd(28)} ${r.result.padEnd(20)} ${r.size || ''}`);

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Production workers run with their own traced dependency tree. */
export function ocrRuntimePath(relative) {
  const runtime = process.env.DOXENTRA_OCR_RUNTIME_DIR || path.join(serviceRoot, '.ocr-runtime');
  return path.join(existsSync(path.join(runtime, 'manifest.json')) ? runtime : serviceRoot, relative);
}

/** Whitelisted file-presence diagnostics; no filesystem paths or credentials. */
export function ocrRuntimeStatus() {
  const runtime = process.env.DOXENTRA_OCR_RUNTIME_DIR || path.join(serviceRoot, '.ocr-runtime');
  const present = relative => existsSync(ocrRuntimePath(relative));
  return {
    bundled: existsSync(path.join(runtime, 'manifest.json')),
    platform: process.platform, arch: process.arch,
    tesseractWorker: present('lib/ocr/tesseractWorker.js'),
    tesseractModel: present('data/tessdata/eng.traineddata'),
    paddleWorker: present('lib/ocr/paddleWorker.js'),
    paddleModel: present('node_modules/@gutenye/ocr-models/assets/ch_PP-OCRv4_rec_infer.onnx'),
    onnxBinding: present(`node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`),
  };
}

/** Safe diagnostics: never send native error messages or OCR text to logs. */
export function ocrErrorCode(error) {
  if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)) return 'OCR_DEPENDENCY_MISSING';
  if (error?.code === 'ENOENT') return 'OCR_ASSET_MISSING';
  if (error?.code === 'ERR_DLOPEN_FAILED') return 'OCR_NATIVE_LOAD_FAILED';
  return ['OCR_TIMEOUT', 'OCR_DEPENDENCY_MISSING', 'OCR_ASSET_MISSING', 'OCR_NATIVE_LOAD_FAILED', 'OCR_WORKER_EXITED'].includes(error?.code)
    ? error.code : 'OCR_ENGINE_FAILED';
}

/** Bound worker startup AND recognition; a failed startup cannot poison the queue. */
export function createOcrWorkerClient({ entrypoint, workerData, idleMs = 60_000,
  spawn = (file, options) => new Worker(file, options) }) {
  let worker;
  let queue = Promise.resolve();
  let idle;
  const shutdown = async () => {
    clearTimeout(idle);
    const current = worker;
    worker = null;
    await current?.terminate();
  };
  const run = (payload, { timeoutMs = 20_000, signal } = {}) => {
    const deadline = Date.now() + timeoutMs;
    const operation = queue.then(async () => {
      if (signal?.aborted || deadline <= Date.now()) throw Object.assign(new Error('OCR cancelled'), { code: 'OCR_TIMEOUT' });
      clearTimeout(idle);
      const active = worker ||= spawn(ocrRuntimePath(entrypoint), { execArgv: [], workerData: workerData?.() });
      // Keep an idle worker's late errors from escaping as an uncaught exception.
      if (!active.listenerCount('error')) active.on('error', () => {
        if (worker === active) worker = null;
      });
      active.ref();
      try {
        return await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            active.off('message', message); active.off('error', error); active.off('exit', exited);
            signal?.removeEventListener('abort', aborted);
          };
          const fail = code => { cleanup(); reject(Object.assign(new Error('OCR worker failed'), { code })); };
          const message = result => { cleanup(); result.error ? reject(Object.assign(new Error('OCR failed'), { code: ocrErrorCode(result.error) })) : resolve(result.result); };
          const error = err => fail(ocrErrorCode(err));
          const exited = () => fail('OCR_WORKER_EXITED');
          const aborted = () => fail('OCR_TIMEOUT');
          const timer = setTimeout(aborted, Math.max(1, deadline - Date.now()));
          active.once('message', message); active.once('error', error); active.once('exit', exited);
          signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) return aborted();
          try { active.postMessage(payload); } catch (err) { error(err); }
        });
      } catch (err) {
        await shutdown();
        throw err;
      } finally {
        active.unref();
        if (worker === active) {
          idle = setTimeout(() => { void shutdown(); }, idleMs);
          idle.unref?.();
        }
      }
    });
    queue = operation.catch(() => {});
    return operation;
  };
  return { run, shutdown };
}

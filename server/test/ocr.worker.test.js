import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOcrWorkerClient } from '../lib/ocr/workerClient.js';

class FakeWorker extends EventEmitter {
  ref() {}
  unref() {}
  async terminate() { this.terminated = true; }
}

test('a stalled worker startup times out, terminates and does not poison the next OCR request', async () => {
  const workers = [];
  const client = createOcrWorkerClient({ entrypoint: 'unused.js', spawn: () => {
    const worker = new FakeWorker();
    worker.postMessage = () => {
      if (workers.length > 1) setImmediate(() => worker.emit('message', { result: { text: 'Recovered' } }));
    };
    workers.push(worker);
    return worker;
  } });
  try {
    await assert.rejects(client.run({}, { timeoutMs: 30 }), error => error.code === 'OCR_TIMEOUT');
    assert.equal(workers[0].terminated, true);
    assert.equal((await client.run({}, { timeoutMs: 1000 })).text, 'Recovered');
    assert.equal(workers.length, 2);
  } finally { await client.shutdown(); }
});

test('missing worker dependencies report a safe actionable error without leaking the module error text', async () => {
  const client = createOcrWorkerClient({ entrypoint: 'unused.js', spawn: () => {
    const worker = new FakeWorker();
    worker.postMessage = () => setImmediate(() => worker.emit('error', Object.assign(new Error('private document data'), { code: 'ERR_MODULE_NOT_FOUND' })));
    return worker;
  } });
  try {
    await assert.rejects(client.run({}), error => error.code === 'OCR_DEPENDENCY_MISSING' && !error.message.includes('private'));
  } finally { await client.shutdown(); }
});

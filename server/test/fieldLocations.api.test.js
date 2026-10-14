import test from 'node:test';
import assert from 'node:assert/strict';
import { makePng } from './helpers/files.js';
process.env.MONGO_URI = '';
process.env.VERCEL = '1';
const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const { saveGraph, getDocument, saveFieldBoxes } = await import('../lib/db.js');
const { putObject } = await import('../lib/storage.js');
const { attachObservedBoxes } = await import('../lib/geminiPipeline.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const owner = { guestId: 'location_workspace_1234567890' };
const headers = { 'x-guest-id': owner.guestId, 'content-type': 'application/json' };
test.after(() => { setGeminiClient(null); server.close(); });
const request = async (id, page = 1, customHeaders = headers) => {
  const res = await fetch(`${base}/documents/${id}/field-locations`, { method: 'POST', headers: customHeaders, body: JSON.stringify({ page }) });
  return { status: res.status, body: await res.json() };
};

test('scan locations are owner scoped, coalesced, persisted and preserve reviews', async () => {
  const file = await putObject('location-test.png', makePng(), 'image/png');
  const doc = await saveGraph({ guestId: owner.guestId, filename: 'scan.png', file, extraction: { pageCount: 1, fields: [
    { key: 'title', value: 'प्रज्ञावर्धन स्तोत्रम्', page: 1, review: { status: 'confirmed' } },
    { key: 'line', value: 'Another line', page: 1 },
  ] } });
  let calls = 0;
  setGeminiClient({ models: { async generateContent(req) {
    calls++;
    assert.equal(req.contents[0].parts[1].inlineData.mimeType, 'image/png');
    await new Promise(resolve => setTimeout(resolve, 20));
    return { text: JSON.stringify({ locations: [
      { key: 'title', box: [40, 200, 90, 800] }, { key: 'line', box: [200, 100, 260, 600] },
      { key: 'unknown', box: [0, 0, 1000, 1000] },
    ] }) };
  } } });
  assert.equal((await request(doc._id, 1, { ...headers, 'x-guest-id': 'other_workspace_1234567890' })).status, 404);
  for (const page of [0, 2, 1.5]) assert.equal((await request(doc._id, page)).status, 400);
  const results = await Promise.all([request(doc._id), request(doc._id)]);
  assert.ok(results.every(r => r.status === 200));
  assert.equal(calls, 1);
  assert.equal(results[0].body.locations.length, 2);
  assert.deepEqual(results[0].body.locations[0].box, [40, 200, 90, 800]);
  assert.equal((await request(doc._id)).status, 200);
  assert.equal(calls, 1, 'persisted boxes avoid another Gemini request');
  const stored = await getDocument(doc._id, owner);
  assert.deepEqual(stored.extraction.fields[0].review, { status: 'confirmed' });
  await saveFieldBoxes(doc._id, owner, [{ key: 'title', value: 'stale value', box: [1, 1, 2, 2] }]);
  assert.deepEqual(stored.extraction.fields[0].box, [40, 200, 90, 800]);
});

test('missing or invalid locations never fabricate a highlight', async () => {
  const file = await putObject('location-invalid.png', makePng(), 'image/png');
  const doc = await saveGraph({ guestId: owner.guestId, file, extraction: { pageCount: 1, fields: [{ key: 'title', value: 'Missing', page: 1 }] } });
  setGeminiClient({ models: { async generateContent() {
    return { text: JSON.stringify({ locations: [{ key: 'title', box: [0, 0, 1000, 1000] }] }) };
  } } });
  const result = await request(doc._id);
  assert.equal(result.status, 200);
  assert.equal(result.body.locations[0].box, null);
});

test('OCR coordinates transfer only for a unique matching value on its source page', () => {
  const result = { fields: [{ key: 'a', value: '१२३ ४', page: 1 }, { key: 'b', value: 'repeated', page: 1 }, { key: 'c', value: 'absent', page: 1 }] };
  attachObservedBoxes(result, [[{ value: '1234', box: [10, 20, 30, 40] },
    { value: 'repeated', box: [10, 20, 30, 40] }, { value: 'repeated', box: [50, 20, 70, 40] }]]);
  assert.deepEqual(result.fields[0].box, [10, 20, 30, 40]);
  assert.equal(result.fields[1].box, undefined);
  assert.equal(result.fields[2].box, undefined);
});

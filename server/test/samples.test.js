// End-to-end over the synthetic samples in samples/: the real API, text
// extraction, validation, confidence scoring and search, with Gemini replaced
// by the canned answers in test/fixtures/gemini/sample-*.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeGemini } from './helpers/fakeGemini.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const samples = JSON.parse(readFileSync(new URL('../../samples/manifest.json', import.meta.url)));
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/gemini/${name}`, import.meta.url)));
const typeOf = file => (file.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf');

const signup = await fetch(base + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `samples${Date.now()}@example.com`, password: 'secret12', phone: '1', age: 20 }),
});
const auth = { authorization: `Bearer ${(await signup.json()).token}` };

// Image-quality reports of the photos, as src/lib/quality.ts measures them in Chromium.
const QUALITY = {
  e: { width: 1588, height: 2246, sharpness: 72, brightness: 252, contrast: 111, warnings: [] },
  k: { width: 1588, height: 2246, sharpness: 11, brightness: 110, contrast: 158, warnings: ['blurry', 'dark'] },
};

const results = {};
for (const s of samples) {
  const { _match, ...answer } = fixture(s.fixture);
  const fake = fakeGemini([{ json: answer }]);
  setGeminiClient(fake);
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(new URL(`../../samples/${s.file}`, import.meta.url))], { type: typeOf(s.file) }), s.file);
  if (QUALITY[s.file[0]]) fd.append('quality', JSON.stringify([QUALITY[s.file[0]]]));
  const r = await fetch(base + '/extract', { method: 'POST', body: fd, headers: auth });
  results[s.file[0]] = { status: r.status, doc: (await r.json()).documents[0], calls: fake.calls };
  setGeminiClient(null);
}
const doc = k => results[k].doc;
const issue = (k, re) => doc(k).issues.find(i => re.test(i.message));

test('every sample is extracted with a type, a summary and sourced fields', () => {
  const expected = { a: 'invoice', b: 'invoice', c: 'certificate', d: 'marksheet', e: 'application_form', f: 'identity_document', g: 'institutional_record', h: 'report', i: 'identity_document', j: 'invoice', k: 'application_form' };
  for (const [k, type] of Object.entries(expected)) {
    assert.equal(results[k].status, 200, k);
    assert.equal(doc(k).docType, type, k);
    // Calibrated (classify.js): model, keywords and required-field coverage.
    assert.ok(doc(k).docTypeConfidence >= 0.85, `${k} type confidence ${doc(k).docTypeConfidence}`);
    assert.equal(doc(k).typeCandidates[0].docType, type, `${k} first candidate`);
    assert.equal(doc(k).typeCandidates[0].confidence, doc(k).docTypeConfidence, `${k} badge = first candidate`);
    assert.ok(doc(k).summary.length > 40, `${k} summary`);
    assert.equal(results[k].calls.length, 1, `${k}: one Gemini call`);
    for (const f of doc(k).fields.filter(x => x.value != null)) {
      assert.ok(f.page >= 1 && f.sourceQuote, `${k}.${f.key} has page and quote`);
      assert.ok(['high', 'medium', 'low'].includes(f.confidenceBand), `${k}.${f.key} band`);
    }
  }
});

test('the benchmark ground truth covers every sample and agrees with the canned answers', () => {
  const truth = JSON.parse(readFileSync(new URL('../../samples/ground-truth.json', import.meta.url))).documents;
  assert.deepEqual(Object.keys(truth).sort(), samples.map(s => s.file).sort());
  for (const s of samples) {
    const t = truth[s.file];
    const d = doc(s.file[0]);
    assert.equal(d.docType, t.docType, s.file);
    assert.equal(d.docSubtype, t.docSubtype, s.file);
    for (const key of Object.keys(t.fields)) assert.ok(d.fields.some(f => f.key === key && f.value != null), `${s.file} ${key}`);
  }
});

test('subtypes and categories of the samples', () => {
  const expected = { a: 'tax_invoice', b: 'tax_invoice', c: 'completion', d: 'board', e: 'admission', f: 'student_id', g: 'notice', h: 'inspection', i: 'student_id', j: 'tax_invoice', k: 'admission' };
  for (const [k, sub] of Object.entries(expected)) assert.equal(doc(k).docSubtype, sub, k);
  assert.equal(doc('d').docCategory, 'Academic');
  assert.equal(doc('f').docCategory, 'Identity');
});

test('image quality: the blurry, dark photo is flagged and its OCR values capped at 75 %', () => {
  const quality = d => d.issues.filter(i => i.type === 'quality').map(i => `${i.severity}:${i.rule}`);
  assert.deepEqual(quality(doc('k')), ['warning:image.blurry', 'warning:image.dark']);
  assert.match(doc('k').issues.find(i => i.rule === 'image.blurry').message, /blurry \(sharpness 11, should be at least 25\)/);
  assert.deepEqual(quality(doc('e')), [], 'the clean scan of the same form');
  for (const f of doc('k').fields.filter(f => f.value != null)) {
    assert.ok(f.confidence <= 0.75, `${f.key} ${f.confidence}`);
  }
  assert.ok(doc('k').fields.some(f => f.confidenceDetail?.capped?.includes('image_quality')));
  assert.ok(doc('k').overallConfidence < doc('e').overallConfidence - 0.1, `${doc('k').overallConfidence} vs ${doc('e').overallConfidence}`);
});

test('digital PDFs use the text layer; scans, photos and the garbled Hindi PDF use OCR', () => {
  for (const k of ['a', 'b', 'c', 'd', 'h']) {
    assert.equal(doc(k).ocrUsed, false, k);
    assert.ok(!results[k].calls[0].contents[0].parts.some(p => p.inlineData), `${k} sends text only`);
  }
  assert.equal(doc('e').ocrUsed, true);
  assert.equal(results.e.calls[0].contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(doc('f').ocrUsed, true);
  assert.equal(doc('f').textLayer, 'scanned');
  assert.equal(doc('g').ocrUsed, true, 'garbled Hindi text layer: file attached');
  assert.ok(results.g.calls[0].contents[0].parts.some(p => p.inlineData));
});

test('a correct digital invoice verifies with high confidence and no errors', () => {
  const a = doc('a');
  assert.ok(a.overallConfidence >= 0.9, `overall ${a.overallConfidence}`);
  assert.equal(a.issueCounts.error, 0, JSON.stringify(a.issues));
  const total = a.fields.find(f => f.key === 'total_amount');
  assert.equal(total.normalizedValue, 18880);
  assert.equal(total.confidenceBand, 'high');
  assert.equal(total.confidenceDetail.quoteFound, true);
});

test('planted problems are flagged with the right severity', () => {
  const total = issue('b', /Total ₹11,710 does not match ₹9,500 \+ tax ₹1,710 = ₹11,210/);
  assert.equal(total?.severity, 'error');
  assert.equal(issue('b', /Seller GSTIN is missing/)?.severity, 'error');

  assert.equal(issue('c', /Valid until \(2023-08-19\) is before issue date \(2024-08-20\)/)?.severity, 'error');
  assert.equal(issue('c', /written differently: "Rohan Mehta" and "Rohan Mehtaa"/)?.severity, 'warning');

  assert.equal(issue('d', /Subject marks add up to 408, but the total shown is 418/)?.severity, 'error');
  assert.ok(!issue('d', /Percentage/), '83.60% is consistent with the printed 418/500');

  for (const k of ['a', 'e', 'f', 'g', 'h', 'i', 'j']) assert.equal(doc(k).issueCounts.error, 0, `${k}: ${JSON.stringify(doc(k).issues)}`);
});

test('OCR values are capped at 0.90 and the Hindi notice verifies against the transcription', () => {
  for (const k of ['e', 'f']) assert.ok(doc(k).fields.every(f => f.confidence <= 0.9), k);
  const subject = doc('g').fields.find(f => f.key === 'title_or_subject');
  assert.equal(subject.confidenceDetail.quoteFound, true);
  assert.ok(subject.confidence > 0.5);
});

test('search finds Hindi and English text across the samples, with filters', async () => {
  const search = async params => (await (await fetch(`${base}/search?${new URLSearchParams(params)}`, { headers: auth })).json()).results;
  let hits = await search({ q: 'परीक्षा' });
  assert.equal(hits[0].docType, 'institutional_record');
  hits = await search({ q: 'GSTIN' });
  assert.ok(hits.length && hits.every(h => h.docType === 'invoice'));
  hits = await search({ q: 'Rohan' });
  assert.equal(hits[0].docType, 'certificate');
  hits = await search({ q: 'Example', type: 'report' });
  assert.ok(hits.length && hits.every(h => h.docType === 'report'));
  hits = await search({ q: 'Arjun', minConfidence: '0.95' });
  assert.equal(hits.length, 0, 'OCR values are capped at 0.90');
});

test('redacted view and exports of the samples carry no personal data', async () => {
  const secrets = {
    e: ['Neha', 'Prakash', '05/09/2006', '2006-09-05', '98765', 'neha.rao', 'Demo Colony', 'ADM/2024/1093'],
    i: ['Asha', 'Verma', 'Suresh', '14/03/2006', '2006-03-14', '2401587', 'Demo Nagar'],
  };
  for (const [k, list] of Object.entries(secrets)) {
    const id = doc(k).id;
    const view = await (await fetch(`${base}/documents/${id}?redact=1`, { headers: auth })).json();
    const json = await (await fetch(`${base}/documents/${id}/export?format=json&redact=1`, { headers: auth })).text();
    const res = await fetch(`${base}/documents/${id}/export?format=csv&redact=true`, { headers: auth });
    const csv = await res.text();
    assert.equal(view.redacted, true);
    assert.match(res.headers.get('content-disposition'), /-redacted\.csv"/);
    for (const secret of list) {
      for (const [what, text] of [['view', JSON.stringify(view)], ['json', json], ['csv', csv]]) assert.ok(!text.includes(secret), `${k} ${what}: ${secret}`);
    }
  }
  // Cross-document issues and the entity graph name the people of other documents too.
  for (const path of ['/crosscheck', `/crosscheck?documentId=${doc('i').id}`, '/entity-graph']) {
    const text = await (await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}redact=1`, { headers: auth })).text();
    for (const secret of [...secrets.i, 'Varma', '14/02/2006']) assert.ok(!text.includes(secret), `${path}: ${secret}`);
  }
  const masked = await (await fetch(`${base}/crosscheck?redact=1`, { headers: auth })).json();
  assert.equal(masked.issues.length, 3);
  assert.match(masked.issues.find(i => i.rule === 'cross.dob_mismatch').message, /Date of birth of A\. V\. differs: "XX\/XX\/2006"/);
  // Business data stays; the plain view is unchanged.
  const inv = await (await fetch(`${base}/documents/${doc('a').id}?redact=1`, { headers: auth })).json();
  assert.match(JSON.stringify(inv), /Example Traders Pvt Ltd.*27AAACE1234F1Z6/);
  // E-mail addresses are always masked, even a business one.
  assert.deepEqual(inv.redaction.fields.map(f => f.key), ['seller_email']);
  const plain = await (await fetch(`${base}/documents/${doc('i').id}`, { headers: auth })).json();
  assert.equal(plain.fields.find(f => f.key === 'holder_name').value, 'Asha Verma');
  assert.equal(plain.redacted, undefined);
});

test('Hindi: transliterated values, cross-language search and translation of the notice', async () => {
  const g = doc('g');
  const subject = g.fields.find(f => f.key === 'title_or_subject');
  assert.equal(subject.transliteration, 'varshik pariksha karyakram / Annual Examination Schedule');
  assert.equal(g.fields.find(f => f.key === 'reference_number').transliteration, undefined, 'only Hindi values');

  const found = async q => [...new Set((await (await fetch(`${base}/search?q=${encodeURIComponent(q)}`, { headers: auth })).json()).results.map(r => r.documentId))];
  assert.deepEqual(await found('suchna'), [g.id]);
  assert.ok((await found('pradhanacharya')).includes(g.id));
  assert.ok((await found('आशा')).includes(doc('i').id), 'Hindi query, English document');

  const translate = body => fetch(`${base}/documents/${g.id}/translate`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // Without the AI: transliteration into Latin letters; Hindi needs the AI.
  let r = await (await translate({ to: 'en' })).json();
  assert.equal(r.translation.method, 'transliteration');
  assert.match(r.translation.pages[0].text, /sabhi chhatron evan abhibhavakon ko suchit kiya jata hai/);
  assert.equal((await translate({ to: 'hi' })).status, 503);
  assert.equal((await translate({ to: 'fr' })).status, 400);
  // With the AI: a translation, kept on the document.
  const { _match, ...answer } = fixture('translate-g-notice.json');
  const fake = fakeGemini([{ json: answer }]);
  setGeminiClient(fake);
  try {
    r = await (await translate({ to: 'en' })).json();
    assert.equal(r.translation.method, 'ai');
    assert.match(fake.calls[0].contents[0].parts[0].text, /^TRANSLATION TASK: translate this document content into English/);
    assert.deepEqual(r.translation.fields.map(f => f.key), ['title_or_subject', 'issuing_institution', 'issued_by_designation']);
    assert.equal(r.translation.fields[1].original, 'Model Public School (आदर्श पब्लिक स्कूल)');
    assert.match(r.translation.pages[0].text, /annual examination will begin from 15\/03\/2024/);
    r = await (await translate({ to: 'en' })).json();
    assert.equal(r.cached, true);
    assert.equal(fake.calls.length, 1);
  } finally {
    setGeminiClient(null);
  }
  const saved = await (await fetch(`${base}/documents/${g.id}`, { headers: auth })).json();
  assert.equal(saved.translations.en.method, 'ai');
  assert.deepEqual((await (await fetch(`${base}/documents/${g.id}?redact=1`, { headers: auth })).json()).translations, {});
});

test('entity graph: people and organisations, their documents and red conflict edges', async () => {
  const g = await (await fetch(`${base}/entity-graph`, { headers: auth })).json();
  assert.equal(g.success, true);
  const node = id => g.nodes.find(n => n.id === id);
  const ids = new Set(g.nodes.map(n => n.id));
  for (const e of g.edges) assert.ok(ids.has(e.source) && ids.has(e.target), `${e.source} → ${e.target}`);
  // Every node but the workspace has its parent, linked by a "contains" edge.
  for (const n of g.nodes.filter(n => n.parentId)) {
    assert.ok(g.edges.some(e => e.label === 'contains' && e.source === n.parentId && e.target === n.id), n.id);
  }
  assert.equal(g.stats.documents, Object.keys(results).length);
  // Asha Verma's marksheet and ID card hang under one person.
  const asha = g.nodes.find(n => n.caption === 'Person' && /Asha Verma/.test(n.label));
  assert.equal(node(`doc:${doc('d').id}`).parentId, asha.id);
  assert.equal(node(`doc:${doc('i').id}`).parentId, asha.id);
  assert.match(asha.desc, /2 documents, linked by a shared identifier/);
  // Both invoices from Example Traders hang under the seller.
  const seller = node(`doc:${doc('a').id}`).parentId;
  assert.equal(node(`doc:${doc('j').id}`).parentId, seller);
  assert.match(node(seller).label, /Example Traders/);
  // One red edge per conflict, between the conflicting fields.
  const red = g.edges.filter(e => e.kind === 'mismatch');
  assert.deepEqual(red.map(e => e.rule).sort(), ['cross.dob_mismatch', 'cross.father_mismatch', 'cross.invoice_conflict']);
  const dob = red.find(e => e.rule === 'cross.dob_mismatch');
  assert.deepEqual([dob.source, dob.target].sort(), [`field:${doc('d').id}:date_of_birth`, `field:${doc('i').id}:date_of_birth`].sort());
  assert.equal(node(dob.source).severity, 'error');
  assert.equal(g.stats.mismatches, 3);
});

test('cross-document checks find exactly the planted conflicts between samples', async () => {
  const r = await (await fetch(`${base}/crosscheck`, { headers: auth })).json();
  const got = r.issues.map(i => `${i.severity}:${i.rule}`).sort();
  assert.deepEqual(got, ['error:cross.dob_mismatch', 'error:cross.invoice_conflict', 'warning:cross.father_mismatch'], JSON.stringify(r.issues, null, 1));
  const dob = r.issues.find(i => i.rule === 'cross.dob_mismatch');
  assert.deepEqual(dob.refs.map(x => x.documentId).sort(), [doc('d').id, doc('i').id].sort());
  assert.match(dob.message, /Roll no\. 2401587/);
  const inv = r.issues.find(i => i.rule === 'cross.invoice_conflict');
  assert.match(inv.message, /Invoice ET\/2024-25\/0147 from Example Traders Pvt Ltd .* ₹18,880 .* ₹18,762/);
  // Per document: only the issues that involve it.
  const forCert = await (await fetch(`${base}/crosscheck?documentId=${doc('c').id}`, { headers: auth })).json();
  assert.equal(forCert.count, 0);
  const forId = await (await fetch(`${base}/crosscheck?documentId=${doc('i').id}`, { headers: auth })).json();
  assert.equal(forId.count, 2);
  assert.equal((await fetch(`${base}/crosscheck?documentId=nope`, { headers: auth })).status, 404);
});

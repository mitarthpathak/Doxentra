import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDevanagari, phoneticKey, translationsOf, transliterate } from '../lib/translit.js';
import { searchDocuments, tokenMatch } from '../lib/search.js';

test('transliteration: readable Latin for names and words', () => {
  const cases = {
    'आशा वर्मा': 'asha varma', 'सुरेश': 'suresh', 'परीक्षा': 'pariksha', 'वार्षिक': 'varshik', 'कार्यक्रम': 'karyakram',
    'आदर्श पब्लिक स्कूल': 'adarsh pablik skul', 'प्रधानाचार्य': 'pradhanacharya', 'मित्र': 'mitra', 'न': 'na', 'हिंदी': 'hindi',
    'संबंध': 'sambandh', 'ज़िला': 'zila', 'फ़ीस': 'fis', 'राजस्थान': 'rajasthan', '२०२४': '2024',
  };
  for (const [hi, en] of Object.entries(cases)) assert.equal(transliterate(hi), en, hi);
  assert.equal(transliterate('नाम: आशा वर्मा (Class XII)', { capitalize: true }), 'Nam: Asha Varma (Class XII)');
  assert.equal(transliterate('Model Public School'), 'Model Public School');
  // Decomposed nukta (ज + ़) reads like the precomposed letter.
  assert.equal(transliterate('ज़िला'), 'zila');
  assert.ok(hasDevanagari('सूचना / NOTICE') && !hasDevanagari('NOTICE'));
});

test('phonetic keys: spellings of the same word agree, across scripts', () => {
  for (const group of [['suchna', 'soochana', 'suchana', 'सूचना'], ['pariksha', 'pareeksha', 'परीक्षा'], ['chhatron', 'chatron', 'छात्रों'], ['asha', 'aasha', 'आशा']]) {
    assert.equal(new Set(group.map(phoneticKey)).size, 1, group.join(' '));
  }
  assert.notEqual(phoneticKey('verma'), phoneticKey('varma'), 'different spellings of a name stay different');
});

test('token matching across scripts and the glossary', () => {
  assert.equal(tokenMatch('suchna', 'सूचना'), 0.6);
  assert.equal(tokenMatch('आशा', 'asha'), 0.6);
  assert.equal(tokenMatch('as', 'आशा'), 0, 'short tokens do not match across scripts');
  assert.equal(tokenMatch('2024', '२०२४'), 0, 'digits are compared after normalisation, not by sound');
  assert.deepEqual(translationsOf('examination'), ['परीक्षा']);
  assert.deepEqual(translationsOf('परीक्षा'), ['examination', 'exam']);
});

test('search: a Latin query finds Hindi text, a Hindi query finds English text', () => {
  const docs = [
    { _id: 'hi', filename: 'notice.pdf', createdAt: new Date(), extraction: { title: 'सूचना', summary: '', fields: [], entities: [], issues: [], rawTextByPage: ['वार्षिक परीक्षा 15/03/2024 से प्रारंभ होगी।'] } },
    { _id: 'en', filename: 'card.pdf', createdAt: new Date(), extraction: { title: 'Student ID', summary: 'Card of Asha Verma', fields: [{ key: 'holder_name', label: 'Holder name', value: 'Asha Verma', confidence: 0.9 }], entities: [], issues: [] } },
  ];
  const ids = q => [...new Set(searchDocuments(docs, { q }).map(h => h.documentId))];
  assert.deepEqual(ids('suchna'), ['hi']);
  assert.deepEqual(ids('varshik pariksha'), ['hi']);
  assert.deepEqual(ids('examination'), ['hi'], 'by the glossary');
  assert.deepEqual(ids('आशा'), ['en']);
  const hit = searchDocuments(docs, { q: 'pariksha' })[0];
  assert.match(hit.snippet.slice(hit.highlights[0][0], hit.highlights[0][1]), /परीक्षा/);
});

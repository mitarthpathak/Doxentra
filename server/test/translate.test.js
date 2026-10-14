import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeGemini } from './helpers/fakeGemini.js';

process.env.GEMINI_API_KEY = '';
const { setGeminiClient } = await import('../lib/ai.js');
const { translateDocument } = await import('../lib/translate.js');

const doc = {
  audit: [],
  extraction: {
    title: 'सूचना / Notice', summary: 'A notice.',
    fields: [{ key: 'title_or_subject', label: 'Subject', type: 'string', value: 'वार्षिक परीक्षा कार्यक्रम / Annual Examination Schedule' },
      { key: 'date', label: 'Date', type: 'date', value: '02/01/2024' }],
    rawTextByPage: ['सूचना / NOTICE\nवार्षिक परीक्षा 15/03/2024 से प्रारंभ होगी।'],
  },
};

test('translation: explicit rules for bilingual text; Hindi the AI left is transliterated', async () => {
  const fake = fakeGemini([{ json: { title: 'Notice', summary: 'A notice.',
    fields: [{ key: 'title_or_subject', value: 'वार्षिक परीक्षा कार्यक्रम / Annual Examination Schedule' }],
    pages: [{ page: 1, text: 'Notice / NOTICE\nThe annual examination will begin from 15/03/2024.' }] } }]);
  setGeminiClient(fake);
  try {
    const t = await translateDocument(doc, { to: 'en' });
    const prompt = fake.calls[0].contents[0].parts[0].text;
    assert.match(prompt, /replace the Hindi part with its English translation, even when it repeats the English next to it/);
    assert.deepEqual(JSON.parse(prompt.split('SOURCE (JSON):\n')[1]).fields.map(f => f.key), ['title_or_subject'], 'only text fields with Hindi');
    assert.equal(t.method, 'ai');
    assert.equal(t.fields[0].value, 'varshik pariksha karyakram / Annual Examination Schedule');
    assert.equal(t.transliterated, 1);
    assert.match(t.pages[0].text, /annual examination will begin/);
  } finally {
    setGeminiClient(null);
  }
});

test('translation without the AI: English by transliteration, Hindi refused', async () => {
  const t = await translateDocument(doc, { to: 'en' });
  assert.equal(t.method, 'transliteration');
  assert.match(t.pages[0].text, /^suchana \/ NOTICE\nvarshik pariksha 15\/03\/2024 se prarambh hogi\./);
  await assert.rejects(translateDocument(doc, { to: 'hi' }), err => err.status === 503);
  await assert.rejects(translateDocument(doc, { to: 'fr' }), err => err.status === 400);
});

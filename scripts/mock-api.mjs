// Local verification only: runs the real API on :3001 with Gemini replaced by
// canned answers from server/test/fixtures/gemini/*.json, so the whole app can
// be exercised in a browser without an API key.
//   node scripts/mock-api.mjs            (then: npm run client)
//   MOCK_AI=off node scripts/mock-api.mjs   simulates the AI being unavailable
// Samples from scripts/make-samples.mjs get their own fixture (see pick()).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDir = path.join(root, 'server/test/fixtures/gemini');
process.env.VERCEL = '1'; // do not auto-listen; we listen below
if (process.env.MOCK_MONGO_URI) process.env.MONGO_URI = process.env.MOCK_MONGO_URI;
else process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET ||= 'local-mock-secret';

// MOCK_SUPABASE=1 also starts a local stand-in for Supabase Storage (port 54321),
// so the browser's direct-to-storage upload path can be exercised.
if (process.env.MOCK_SUPABASE) {
  const { startFakeSupabase } = await import(path.join(root, 'server/test/helpers/fakeSupabase.js'));
  const sb = startFakeSupabase({ port: 54321 });
  process.env.SUPABASE_URL = 'http://localhost:54321';
  process.env.SUPABASE_SERVICE_ROLE_KEY = sb.serviceKey;
  console.log('Fake Supabase Storage on http://localhost:54321');
} else {
  delete process.env.SUPABASE_URL;
}
const { default: app } = await import(path.join(root, 'server/index.js'));
const { setGeminiClient } = await import(path.join(root, 'server/lib/ai.js'));
const { connectDB } = await import(path.join(root, 'server/lib/db.js'));

const fixtures = readdirSync(fixtureDir)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ name: f, json: JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')) }));

// Scans and photos are matched by file hash (samples/manifest.json),
// digital PDFs by the "_match" regex on their text.
const manifestPath = path.join(root, 'samples/manifest.json');
const byHash = new Map(existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8')).map(m => [m.sha256, m.fixture])
  : []);

function pick(parts) {
  const file = parts.find(p => p.inlineData);
  if (file) {
    const hash = createHash('sha256').update(Buffer.from(file.inlineData.data, 'base64')).digest('hex');
    const name = byHash.get(hash);
    const hit = name && fixtures.find(f => f.name === name);
    if (hit) return hit;
  }
  const text = parts.filter(p => p.text).map(p => p.text).join('\n');
  const doc = text.includes('DOCUMENT TEXT') ? text.slice(text.indexOf('DOCUMENT TEXT')) : '';
  return fixtures.find(f => !f.name.startsWith('translate-') && f.json._match && new RegExp(f.json._match, 'i').test(doc))
    || fixtures.find(f => f.name === 'invoice.json');
}

if (process.env.MOCK_AI !== 'off') {
  setGeminiClient({
    models: {
      async generateContent({ contents, model }) {
        const parts = contents[0].parts;
        const prompt = parts.map(p => p.text || '').join('\n');
        if (prompt.startsWith('TRANSLATION TASK')) {
          // Translations: canned answers (translate-*.json) by the source text; others fall back to transliteration.
          const t = fixtures.find(f => f.name.startsWith('translate-') && new RegExp(f.json._match, 'i').test(prompt));
          if (!t) throw Object.assign(new Error('mock: translation not mocked'), { status: 403 });
          await new Promise(r => setTimeout(r, 600));
          const { _match, ...answer } = t.json;
          console.log(`[mock] ${model} -> ${t.name}`);
          return { text: JSON.stringify(answer), modelVersion: `${model} (mock)` };
        }
        if (!parts.some(p => /DOCUMENT TEXT|ocrText|document-intelligence/.test(p.text || ''))) {
          // Concept-map prompt: let the caller fall back to the keyword map.
          throw Object.assign(new Error('mock: concept map not mocked'), { status: 403 });
        }
        const f = pick(parts);
        await new Promise(r => setTimeout(r, 600));
        const { _match, ...answer } = f.json;
        console.log(`[mock] ${model} -> ${f.name}`);
        return { text: JSON.stringify(answer), modelVersion: `${model} (mock)` };
      },
    },
  });
}

await connectDB();
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Mock API on http://localhost:${port} (AI ${process.env.MOCK_AI === 'off' ? 'off' : 'mocked'})`));

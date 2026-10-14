import test from 'node:test';
import { runSearchSuite } from './helpers/searchSuite.js';

// In-memory storage backend.
process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const server = app.listen(0);
test.after(() => server.close());

test('search API (in-memory backend)', t => runSearchSuite(t, { base: `http://127.0.0.1:${server.address().port}/api`, setGeminiClient }));

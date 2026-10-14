import '../env.js';
// Load first, then neutralize all credentials (including any numbered keys).
// Never let a developer's server/.env send test files to external services.
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SECRET_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
// Existing fixtures model the previous one-call pipeline; Gemini pipeline tests opt in explicitly.
process.env.DOXENTRA_ANALYSIS_PIPELINE = 'legacy';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
for (const key of Object.keys(process.env)) if (/^GEMINI_API_KEY_\d+$/.test(key)) process.env[key] = '';

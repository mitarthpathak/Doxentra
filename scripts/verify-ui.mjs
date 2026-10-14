// Browser check of the document-intelligence screens (key checkpoints only).
// Usage: node scripts/verify-ui.mjs [outDir] [file1 file2 ...]
// Expects the web app on :5173 and an API on :3001 (scripts/mock-api.mjs without a key).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadChromium, watchPage } from './lib/browser.mjs';

const out = process.argv[2] || 'docs/screenshots';
const files = process.argv.slice(3);
const WEB = process.env.WEB_URL || 'http://localhost:5173';
mkdirSync(out, { recursive: true });

const chromium = await loadChromium();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
let step = 'start';
const problems = watchPage(page, () => `(${step})`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: opts.fullPage ?? true });
};
const nav = label => page.locator('header nav button', { hasText: new RegExp(`^${label}$`) }).click();
const fileInput = () => page.getByTestId('file-input');
const asUpload = f => ({ name: path.basename(f), mimeType: /\.png$/i.test(f) ? 'image/png' : /\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'application/pdf', buffer: readFileSync(f) });

// 1. Signed out: upload one document -> result view.
step = 'upload';
await page.goto(WEB);
await nav('Upload');
await fileInput().setInputFiles(asUpload(files[0]));
await page.getByTestId('document-screen').waitFor({ timeout: 60_000 });
check('upload opens the result view', true);
check('document type badge', await page.getByTestId('doc-type-badge').isVisible(), await page.getByTestId('doc-type-badge').innerText());
check('summary shown', (await page.getByTestId('doc-summary').innerText()).length > 20);
const rows = await page.getByTestId('field-row').count();
check('field rows with confidence chips', rows > 3, `${rows} rows`);
check('issues panel', await page.getByTestId('issues-panel').isVisible());
await shot('result-desktop');

// 2. Source panel.
step = 'source';
await page.getByTestId('field-row').first().click();
await page.getByTestId('source-panel').waitFor();
check('source panel opens with quote and page', (await page.locator('[data-testid="source-panel"] blockquote').count()) === 1 && /page \d/i.test(await page.getByTestId('source-panel').innerText()));
await shot('source-panel', { fullPage: false });

// 3. Keyboard: Enter on a field row toggles the source panel.
await page.getByTestId('field-row').nth(1).focus();
await page.keyboard.press('Enter');
check('field row works from the keyboard', await page.getByTestId('field-row').nth(1).getAttribute('aria-pressed') === 'true');

// 4. Export (signed out: formats the result on screen).
step = 'export';
for (const format of ['JSON', 'CSV']) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Export ${format}` }).click()]);
  const target = `${out}/export-signed-out.${format.toLowerCase()}`;
  await download.saveAs(target);
  const body = readFileSync(target, 'utf8');
  check(`export ${format} (signed out)`, format === 'JSON' ? JSON.parse(body).fields.length > 0 : /^﻿?section,key,label/.test(body), download.suggestedFilename());
}

// 5. Mobile layout of the result view.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal scroll on mobile', overflow <= 0, `overflow ${overflow}px`);
const navOverflow = await page.evaluate(() => {
  const nav = document.querySelector('nav.fixed');
  return nav ? nav.scrollWidth - nav.clientWidth : 0;
});
check('bottom nav fits on mobile', navOverflow <= 0, `overflow ${navOverflow}px`);
await shot('result-mobile');
await page.setViewportSize({ width: 1440, height: 900 });

// 6. Sign up, then multi-file upload.
step = 'signup';
const email = `ui${Date.now()}@example.com`;
const signup = await page.request.post(`${WEB}/api/auth/signup`, { data: { email, password: 'secret12', phone: '9876543210', age: 21 } });
await page.evaluate(t => localStorage.setItem('doxentra_token', t), (await signup.json()).token);
await page.reload();
step = 'multi-upload';
await nav('Upload');
await fileInput().setInputFiles(files.map(asUpload));
await page.getByTestId('document-screen').waitFor({ timeout: 120_000 });
const chips = await page.locator('[data-testid="document-screen"] button[aria-pressed]').filter({ hasText: /\.(pdf|png|jpe?g|webp)$/i }).count();
// The switcher also lists documents opened earlier in this session.
check('multi-file upload: one result per file', chips >= files.length || files.length === 1, `${chips} documents in this session`);
await shot('multi-upload');

// 7. Export while signed in (by id).
step = 'export-signed-in';
const [csvDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
await csvDownload.saveAs(`${out}/export.csv`);
check('export CSV (signed in)', /section,key,label/.test(readFileSync(`${out}/export.csv`, 'utf8')));

// 8. History shows documents with type, confidence and issues.
step = 'history';
await nav('History');
await page.getByTestId('document-card').first().waitFor();
const cards = await page.getByTestId('document-card').count();
const cardText = await page.getByTestId('document-card').first().innerText();
check('history lists documents', cards >= files.length, `${cards} cards`);
check('history card shows type, confidence and issues', /%/.test(cardText) && /issue/i.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 120));
await shot('history-documents');

// 9. Search with filters, open a hit -> source panel.
step = 'search';
await nav('Search');
const query = process.env.SEARCH_QUERY || 'example';
await page.getByTestId('search-input').fill(query);
await page.getByTestId('search-results').waitFor({ timeout: 10_000 });
const hits = await page.getByTestId('search-hit').count();
check(`search "${query}" finds results`, hits > 0, `${hits} hits`);
check('search highlights the match', (await page.locator('[data-testid="search-results"] mark').count()) > 0);
await shot('search');
await page.getByTestId('search-type').selectOption('certificate');
await page.waitForTimeout(900);
const filtered = await page.getByTestId('search-hit').count();
check('type filter narrows results', filtered < hits || hits === 0, `${filtered} after filter`);
await page.getByTestId('search-type').selectOption('');
await page.getByTestId('search-confidence').selectOption('0.8');
await page.waitForTimeout(900);
await page.getByTestId('search-confidence').selectOption('');
await page.waitForTimeout(900);
const fieldHit = page.getByTestId('search-hit').filter({ hasText: /^Field|Field ·/ }).first();
if (await fieldHit.count()) {
  await fieldHit.click();
  await page.getByTestId('source-panel').waitFor({ timeout: 10_000 });
  check('search hit opens the document at the source panel', true);
  await shot('search-deep-link', { fullPage: false });
} else {
  check('search hit opens the document at the source panel', false, 'no field hit');
}

// 10. Concept map from the document still works (graph, details, quiz).
step = 'concept-map';
await page.getByRole('button', { name: /Concept Map/ }).click();
await page.locator('text=Semantic Architecture').waitFor({ timeout: 60_000 });
check('concept map opens from a document', true);
await nav('Details');
await page.locator('#knowledge-check').waitFor();
check('details and quiz still render', await page.locator('#knowledge-check').isVisible());

// 11. History: delete a document.
step = 'delete';
await nav('History');
await page.getByTestId('document-card').first().waitFor();
page.once('dialog', d => d.accept());
const before = await page.getByTestId('document-card').count();
await page.getByTestId('document-card').first().getByRole('button', { name: 'Delete saved document' }).click();
await page.waitForTimeout(800);
check('delete a document from history', (await page.getByTestId('document-card').count()) === before - 1);
// Reopen another one.
if (before > 1) {
  await page.getByTestId('document-card').first().click();
  await page.getByTestId('document-screen').waitFor();
  check('reopen a document from history', true);
}

check('no console errors or failed requests', problems.length === 0, problems.join('\n'));
writeFileSync(`${out}/verify-results.json`, JSON.stringify({ results, problems }, null, 2));
await browser.close();
process.exitCode = results.every(r => r.ok) ? 0 : 1;

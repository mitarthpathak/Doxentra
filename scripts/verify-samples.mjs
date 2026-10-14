// End-to-end browser pass over the synthetic samples (Phase 9 checkpoints).
// Usage: node scripts/verify-samples.mjs [outDir]
//   Expects the web app on :5173 and scripts/mock-api.mjs on :3001.
//   With MOCK_AI=off on the API, only the AI-unavailable checks run
//   (VERIFY_PART=ai-off).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadChromium, watchPage } from './lib/browser.mjs';

const out = process.argv[2] || 'docs/screenshots';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const PART = process.env.VERIFY_PART || 'main';
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync('samples/manifest.json', 'utf8'));
const sample = letter => manifest.find(m => m.file.startsWith(`${letter}-`)).file;
const asUpload = file => ({
  name: file,
  mimeType: file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.png') ? 'image/png' : 'application/pdf',
  buffer: readFileSync(`samples/${file}`),
});

const chromium = await loadChromium();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
let step = 'start';
// With the AI off, the scan upload is expected to answer 422 (which the browser logs).
const problems = watchPage(page, () => `(${step})`, PART === 'ai-off' ? [/status of 422/] : []);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const shot = async (name, fullPage = true) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage });
};
const nav = label => page.locator('header nav button', { hasText: new RegExp(`^${label}$`) }).click();
const upload = async files => {
  await nav('Upload');
  await page.getByTestId('file-input').setInputFiles(files);
};
const openDoc = async name => {
  await page.locator('[data-testid="document-screen"] button[aria-pressed]', { hasText: name }).click();
  await page.waitForTimeout(400);
};

// Report what was collected even if a step throws.
process.on('uncaughtException', async err => {
  console.log(`ERROR at step "${step}": ${err.message.split('\n')[0]}`);
  if (problems.length) console.log(problems.join('\n'));
  await page.screenshot({ path: `${out}/error-${step}.png`, fullPage: true }).catch(() => {});
  process.exit(1);
});

if (PART === 'ai-off') {
  step = 'ai-off';
  await page.goto(WEB);
  await upload([asUpload(sample('a'))]);
  await page.getByTestId('document-screen').waitFor({ timeout: 60_000 });
  check('AI off: digital PDF gets a basic extraction', /basic rule-based extraction/i.test(await page.getByTestId('document-screen').innerText()));
  check('AI off: still shows type, fields and issues', (await page.getByTestId('field-row').count()) > 0 && await page.getByTestId('issues-panel').isVisible());
  await shot('09-ai-unavailable-basic-extraction');
  await upload([asUpload(sample('e'))]);
  const alert = page.getByRole('alert');
  await alert.waitFor({ timeout: 30_000 });
  check('AI off: scans get a clear message', /needs OCR and the AI service is not configured/.test(await alert.innerText()), await alert.innerText());
  await shot('09-ai-unavailable-scan-message', false);
} else {
  // 1. Sign up and log in through the auth modal.
  step = 'auth';
  await page.goto(WEB);
  const email = `demo${Date.now()}@example.com`;
  await page.locator('header button', { hasText: /sign in/i }).first().click();
  await page.getByRole('button', { name: /^Sign up$/ }).first().click();
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('+91 98765 43210').fill('9876543210');
  await page.getByPlaceholder('••••••••').fill('secret12');
  await page.getByPlaceholder('25').fill('21');
  await page.locator('form button[type="submit"]').click();
  await page.getByRole('button', { name: 'Account menu' }).waitFor();
  check('sign up through the UI', true);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: /Sign Out/ }).click();
  await page.locator('header button', { hasText: /sign in/i }).first().click();
  await page.getByRole('button', { name: /^Sign In$/ }).last().click(); // the modal's tab
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill('secret12');
  await page.locator('form button[type="submit"]').click();
  await page.getByRole('button', { name: 'Account menu' }).waitFor();
  check('log in through the UI', true);

  // 2. Bad file and HEIC are rejected with clear messages.
  step = 'bad-file';
  await nav('Upload');
  await page.getByTestId('file-input').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') });
  await page.getByRole('alert').waitFor({ timeout: 20_000 });
  const badText = await page.getByRole('alert').innerText();
  check('fake image rejected with a clear message', /not a valid image|could not be read as an image/i.test(badText), badText);
  await shot('01-upload-bad-file', false);

  // 3. A large photo is compressed in the browser to fit under 4 MB.
  step = 'big-image';
  const big = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 4000; c.height = 5200;
    const g = c.getContext('2d');
    const img = g.createImageData(c.width, c.height);
    let s = 42;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1664525 + 1013904223) % 4294967296;
      const v = 200 + (s % 56);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.fillStyle = '#111'; g.font = '120px sans-serif'; g.fillText('SYNTHETIC LARGE PHOTO', 300, 600);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  const bigBuffer = Buffer.from(big, 'base64');
  // Files go to storage first (POST /api/uploads without Supabase), then a background job extracts them.
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/uploads') && r.request().method() === 'POST', { timeout: 60_000 });
  await upload([{ name: 'large-photo.png', mimeType: 'image/png', buffer: bigBuffer }]);
  const response = await responsePromise;
  // The server reports the size of the file it stored.
  const sentBytes = (await response.json()).size || 0;
  check('large image compressed below 4 MB before upload', bigBuffer.length > 4 * 1024 * 1024 && sentBytes > 0 && sentBytes < 4 * 1024 * 1024,
    `${(bigBuffer.length / 1048576).toFixed(1)} MB -> ${(sentBytes / 1048576).toFixed(2)} MB received by the server`);
  await page.getByTestId('document-screen').waitFor({ timeout: 60_000 });

  // 4. Multi-file upload of the samples (at most 10 files per upload; k is checked by verify-features.mjs).
  step = 'multi-upload';
  const batch = manifest.slice(0, 10);
  await upload(batch.map(m => asUpload(m.file)));
  await page.getByTestId('document-screen').waitFor({ timeout: 180_000 });
  for (const m of batch) {
    const chip = page.locator('[data-testid="document-screen"] button[aria-pressed]', { hasText: m.file });
    check(`multi-upload result: ${m.file}`, (await chip.count()) === 1);
  }

  // 5. Result view per sample (type badge, OCR badge, summary, fields, issues).
  step = 'results';
  const expectations = {
    a: { type: /Invoice/, ocr: false, errors: 0 },
    b: { type: /Invoice/, ocr: false, issues: [/Seller GSTIN is missing/, /Total ₹11,710 does not match/] },
    c: { type: /Certificate/, ocr: false, issues: [/Valid until \(2023-08-19\) is before issue date/, /written differently/] },
    d: { type: /Marksheet/, ocr: false, issues: [/Subject marks add up to 408, but the total shown is 418/] },
    e: { type: /Application/, ocr: true, errors: 0 },
    f: { type: /Identity/, ocr: true, errors: 0 },
    g: { type: /Letter \/ notice/, ocr: true, errors: 0 },
    h: { type: /Report/, ocr: false, errors: 0 },
  };
  for (const [letter, exp] of Object.entries(expectations)) {
    const file = sample(letter);
    await openDoc(file);
    const badge = await page.getByTestId('doc-type-badge').innerText();
    check(`${letter}: document type`, new RegExp(exp.type.source, 'i').test(badge), badge);
    check(`${letter}: OCR badge ${exp.ocr ? 'shown' : 'hidden'}`, (await page.getByTestId('ocr-badge').count()) === (exp.ocr ? 1 : 0));
    check(`${letter}: summary`, (await page.getByTestId('doc-summary').innerText()).length > 40);
    const issuesText = await page.getByTestId('issues-panel').innerText();
    for (const re of exp.issues || []) check(`${letter}: issue ${re.source}`, re.test(issuesText));
    if (exp.errors === 0) check(`${letter}: no error issues`, !/\bERROR\b/.test(issuesText), issuesText.replace(/\s+/g, ' ').slice(0, 160));
    await shot(`05-result-${file.replace(/\.[^.]+$/, '')}`);
  }

  // 6. Source panel on the mismatching invoice, and the Hindi notice.
  step = 'source';
  await openDoc(sample('b'));
  await page.getByTestId('issue-item').filter({ hasText: /does not match/ }).click();
  await page.getByTestId('source-panel').waitFor();
  check('clicking an issue opens the field source panel', /Total amount/i.test(await page.getByTestId('source-panel').innerText()));
  await shot('06-source-panel-from-issue', false);
  await openDoc(sample('g'));
  // Open a field whose value has Hindi text (which one depends on the model).
  const hindiRow = page.getByTestId('field-row').filter({ hasText: /[\u0900-\u097F]/ }).first();
  await ((await hindiRow.count()) ? hindiRow : page.getByTestId('field-row').first()).click();
  await page.getByTestId('source-panel').waitFor();
  const hindiPanel = await page.getByTestId('source-panel').innerText();
  check('Hindi value shown with its source quote', /[\u0900-\u097F]/.test(hindiPanel) && (await page.locator('[data-testid="source-panel"] blockquote').count()) === 1, hindiPanel.split('\n').slice(0, 3).join(' / '));
  await shot('06-source-panel-hindi', false);

  // 7. Export JSON and CSV of the mismatching invoice.
  step = 'export';
  await openDoc(sample('b'));
  for (const format of ['JSON', 'CSV']) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: `Export ${format}` }).click()]);
    const target = `${out}/07-export-invoice-mismatch.${format.toLowerCase()}`;
    await download.saveAs(target);
    const body = readFileSync(target, 'utf8');
    check(`export ${format}`, format === 'JSON' ? JSON.parse(body).issues.length >= 2 : /issue,inconsistent,error/.test(body), download.suggestedFilename());
  }

  // 8. Search: Hindi, English, filters, deep link.
  step = 'search';
  await nav('Search');
  await page.getByTestId('search-input').fill('परीक्षा');
  await page.getByTestId('search-hit').first().waitFor({ timeout: 10_000 });
  check('Hindi search finds the notice', /Letter \/ notice/i.test(await page.getByTestId('search-hit').first().innerText()));
  await shot('08-search-hindi');
  await page.getByTestId('search-input').fill('GSTIN');
  await page.waitForTimeout(900);
  await page.getByTestId('search-type').selectOption('invoice');
  await page.getByTestId('search-confidence').selectOption('0.8');
  await page.waitForTimeout(900);
  const hits = await page.getByTestId('search-hit').count();
  check('search with type + confidence filters', hits > 0, `${hits} hits`);
  await shot('08-search-filters');
  await page.getByTestId('search-hit').first().click();
  await page.getByTestId('source-panel').waitFor({ timeout: 10_000 });
  check('search result opens the source panel', true);

  // 9. History: types, confidence, issue counts; delete and reopen.
  step = 'history';
  await nav('History');
  await page.getByTestId('document-card').first().waitFor();
  const cards = await page.getByTestId('document-card').count();
  check('history lists all documents', cards >= batch.length, `${cards} cards`);
  await shot('09-history');
  page.once('dialog', d => d.accept());
  await page.getByTestId('document-card').filter({ hasText: 'large-photo' }).getByRole('button', { name: 'Delete saved document' }).click();
  await page.waitForTimeout(800);
  check('delete from history', (await page.getByTestId('document-card').count()) === cards - 1);
  await page.getByTestId('document-card').filter({ hasText: sample('d') }).click();
  await page.getByTestId('document-screen').waitFor();
  check('reopen from history', /Marksheet/i.test(await page.getByTestId('doc-type-badge').innerText()));

  // 10. Concept map, roadmap and quiz from the report.
  step = 'concept-map';
  await nav('History');
  await page.getByTestId('document-card').filter({ hasText: sample('h') }).click();
  await page.getByTestId('document-screen').waitFor();
  await page.getByRole('button', { name: /Concept Map/ }).click();
  await page.locator('text=Semantic Architecture').waitFor({ timeout: 60_000 });
  await shot('10-concept-map-graph', false);
  await nav('Details');
  await page.locator('#knowledge-check').scrollIntoViewIfNeeded();
  check('roadmap and quiz render', await page.locator('#knowledge-check').isVisible());
  await shot('10-details-quiz', false);

  // 11. Mobile result view.
  step = 'mobile';
  await nav('Extract');
  await page.setViewportSize({ width: 390, height: 844 });
  await openDoc(sample('b')).catch(() => {});
  await page.waitForTimeout(600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile: no horizontal scroll', overflow <= 0, `${overflow}px`);
  await shot('11-result-mobile');
}

check('no console errors or failed requests', problems.length === 0, problems.join('\n'));
writeFileSync(`${out}/verify-${PART}.json`, JSON.stringify({ results, problems }, null, 2));
await browser.close();
process.exitCode = results.every(r => r.ok) ? 0 : 1;

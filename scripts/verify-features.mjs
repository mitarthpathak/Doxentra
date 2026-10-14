// Browser checks for the F3–F12 features (key checkpoints only).
// Usage: node scripts/verify-features.mjs [outDir] [section ...]
//   Sections run in order; default: all. Expects the web app on :5173 and
//   scripts/mock-api.mjs on :3001 (canned Gemini answers for samples/).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadChromium, watchPage } from './lib/browser.mjs';

const out = process.argv[2] || 'docs/screenshots/features';
const ALL = ['cross', 'classify', 'entities', 'review', 'mask', 'hindi', 'quality', 'details'];
const sections = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
const WEB = process.env.WEB_URL || 'http://localhost:5173';
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
const problems = watchPage(page, () => `(${step})`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const shot = async (name, fullPage = false) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage });
};
const nav = label => page.locator('header nav button', { hasText: new RegExp(`^${label}$`) }).click();
const upload = async letters => {
  await nav('Upload');
  await page.getByTestId('file-input').setInputFiles(letters.map(l => asUpload(sample(l))));
  await page.getByTestId('document-screen').waitFor({ timeout: 120_000 });
};
const openDoc = async letter => {
  await page.locator('[data-testid="document-screen"] button[aria-pressed]', { hasText: sample(letter) }).click();
  await page.waitForTimeout(500);
};

process.on('uncaughtException', async err => {
  console.log(`ERROR at step "${step}": ${err.message.split('\n')[0]}`);
  if (problems.length) console.log(problems.join('\n'));
  await page.screenshot({ path: `${out}/error-${step}.png`, fullPage: true }).catch(() => {});
  process.exit(1);
});

// Signed in, so every section works on one account's documents.
await page.goto(WEB);
const signup = await page.request.post(`${WEB}/api/auth/signup`, { data: { email: `features${Date.now()}@example.com`, password: 'secret12', phone: '9876543210', age: 21 } });
await page.evaluate(t => localStorage.setItem('doxentra_token', t), (await signup.json()).token);
await page.reload();

if (sections.includes('cross')) {
  step = 'cross';
  await upload(['d', 'i', 'a', 'j']);
  await openDoc('i');
  await page.getByTestId('cross-issues').waitFor({ timeout: 10_000 });
  const text = await page.getByTestId('cross-issues').innerText();
  // Either document may be named first (oldest first), and live titles vary.
  check('ID card shows the date-of-birth conflict with the marksheet',
    /Date of birth of Asha Verma differs/.test(text) && /"14\/02\/2006" in Statement of Marks/.test(text) && /"14\/03\/2006"/.test(text), text.split('\n').slice(0, 3).join(' / '));
  check("and the father's name spelt differently", /Father's \/ guardian's name of Asha Verma differs/.test(text));
  const flagged = await page.getByTestId('field-row').filter({ hasText: /Date of birth/i }).innerText();
  check('the conflicting field is flagged in the field list', /check/i.test(flagged));
  await page.getByTestId('cross-issues').scrollIntoViewIfNeeded();
  await shot('f4-cross-document-issues');
  await page.getByTestId('cross-open').first().click();
  await page.getByTestId('source-panel').waitFor({ timeout: 10_000 });
  const badge = await page.getByTestId('doc-type-badge').innerText();
  const panel = await page.getByTestId('source-panel').innerText();
  check('the link opens the marksheet at the conflicting field', /marksheet/i.test(badge) && /Date of birth/i.test(panel), `${badge} / ${panel.split('\n')[1]}`);
  await openDoc('j');
  await page.getByTestId('cross-issues').waitFor({ timeout: 10_000 });
  check('the duplicate invoice number with another total is an error',
    /ERROR\s*Invoice ET\/2024-25\/0147 from Example Traders Pvt Ltd appears in two documents with different totals/i.test(await page.getByTestId('cross-issues').innerText()));
}

if (sections.includes('classify')) {
  step = 'classify';
  if (!sections.includes('cross')) await upload(['i', 'a']);
  await openDoc('a');
  const badge = page.getByTestId('doc-type-badge');
  check('the invoice shows its subtype next to the type', /tax invoice/i.test(await page.getByTestId('doc-subtype-badge').innerText()));
  check('the type badge explains its confidence', /Financial · AI \d+%, keywords \d+%, required fields found \d+%/.test(await badge.getAttribute('title') || ''), await badge.getAttribute('title'));
  await openDoc('i');
  const sub = await page.getByTestId('doc-subtype-badge').innerText();
  const also = await page.getByTestId('type-candidates').innerText().catch(() => '');
  check('the ID card is a student ID with a runner-up type', /student id/i.test(sub) && /Also possible: Marksheet/i.test(also), `${sub} / ${also}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('f5-classification');
}

if (sections.includes('entities')) {
  step = 'entities';
  if (!sections.includes('cross')) await upload(['d', 'i', 'a', 'j']);
  await nav('Graph');
  await page.getByTestId('graph-mode-entities').click();
  await page.getByTestId('graph-canvas').waitFor({ timeout: 10_000 });
  const labels = await page.getByTestId('graph-node').allInnerTexts();
  check('the graph links Asha Verma, Example Traders and their documents',
    labels.some(l => /Asha Verma\s*Person/i.test(l)) && labels.some(l => /Example Traders.*\s*Organisation/i.test(l)) && labels.some(l => /Statement of Marks/i.test(l)),
    `${labels.length} nodes`);
  const red = await page.locator('[data-testid="mismatch-edge"][data-severity="error"]').count();
  check('conflicting values are joined by red edges', red === 2, `${red} red edges, conflicts: ${await page.getByTestId('graph-conflicts').innerText()}`);
  await shot('f6-entity-graph');
  await page.getByTestId('graph-node').filter({ hasText: /^Date of birth: 14\/03\/2006$/ }).click();
  const dialog = page.getByRole('dialog');
  check('a conflicting field explains the conflict', /Date of birth of Asha Verma differs/.test(await dialog.getByTestId('node-conflicts').innerText()));
  await shot('f6-entity-node');
  await dialog.getByTestId('node-open-document').click();
  await page.getByTestId('source-panel').waitFor({ timeout: 10_000 });
  check('and opens the document at that field', /Date of birth/i.test(await page.getByTestId('source-panel').innerText()));
  await nav('Graph');
  check('the concept-map tab still shows the concept map view', await page.getByTestId('graph-mode-concepts').count() === 1);
}

if (sections.includes('review')) {
  step = 'review';
  if (!sections.includes('cross') && !sections.includes('entities')) await upload(['d', 'i']);
  await nav('Extract');
  await openDoc('i');
  page.on('dialog', d => d.accept());
  const dobRow = page.getByTestId('field-row').filter({ hasText: /Date of birth/i });
  await dobRow.click();
  await page.getByTestId('review-correct').click();
  await page.getByTestId('review-value').fill('14/02/2006');
  await page.getByRole('textbox', { name: 'Note (optional)' }).fill('Checked against the birth certificate');
  await page.getByTestId('review-save').click();
  await page.getByTestId('field-review-status').waitFor({ timeout: 10_000 });
  check('a corrected field is marked and keeps the AI value for reference',
    /Corrected by features.*AI read 14\/03\/2006/s.test(await page.getByTestId('field-review-status').innerText()) && /corrected/i.test(await dobRow.innerText()));
  await page.waitForTimeout(800);
  const cross = await page.getByTestId('cross-issues').innerText().catch(() => '');
  check('the correction settles the date-of-birth conflict with the marksheet', !/Date of birth of Asha Verma differs/.test(cross) && /Father/.test(cross), cross.split('\n')[0]);
  check('the document is in review', /In review · 1\//i.test(await page.getByTestId('review-badge').innerText()));
  await page.getByTestId('field-row').filter({ hasText: /Holder name/i }).click();
  // The previous field's panel animates out first.
  await page.getByTestId('source-panel').filter({ hasText: /Holder name/i }).getByTestId('review-confirm').click();
  await page.getByTestId('field-review-status').waitFor({ timeout: 10_000 });
  await page.getByTestId('review-approve').click();
  await page.getByTestId('review-badge').filter({ hasText: /Approved/i }).waitFor({ timeout: 10_000 });
  const history = await page.getByTestId('audit-entry').allInnerTexts();
  check('the review history lists every action, newest first', history.length === 3 && /Approved the document/.test(history[0]) && /Confirmed Holder name/.test(history[1]) &&
    /Corrected Date of birth: 14\/03\/2006 → 14\/02\/2006/.test(history[2]) && /birth certificate/.test(history[2]), JSON.stringify(history));
  await page.getByTestId('review-history').scrollIntoViewIfNeeded();
  await shot('f7-review-history');
  await dobRow.click();
  await page.getByTestId('source-panel').filter({ hasText: /Date of birth/i }).getByTestId('field-review').scrollIntoViewIfNeeded();
  await shot('f7-field-review');
  await page.getByTestId('review-reset').click();
  await page.getByTestId('review-badge').filter({ hasText: /In review/i }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  check('back to the AI value: the conflict returns and the approval is withdrawn',
    /Date of birth of Asha Verma differs/.test(await page.getByTestId('cross-issues').innerText()) && /approval withdrawn/.test((await page.getByTestId('audit-entry').allInnerTexts())[0]));
}

if (sections.includes('mask')) {
  step = 'mask';
  if (!['cross', 'entities', 'review'].some(x => sections.includes(x))) await upload(['d', 'i']);
  await nav('Extract');
  await openDoc('i');
  await page.getByTestId('field-row').filter({ hasText: /Date of birth/i }).click();
  await page.getByTestId('page-preview').waitFor({ timeout: 10_000 }).catch(() => {});
  await page.getByTestId('mask-toggle').click();
  await page.getByTestId('mask-banner').waitFor({ timeout: 10_000 });
  await page.getByTestId('cross-issues').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const SECRETS = ['Asha', 'Verma', 'Suresh', 'Varma', '14/03/2006', '14/02/2006', '2401587', 'Demo Nagar', 'asha-verma'];
  const shown = await page.getByTestId('document-screen').innerText();
  const leaked = SECRETS.filter(x => shown.toLowerCase().includes(x.toLowerCase()));
  check('masked: no name, date of birth, roll number or address anywhere on the page', leaked.length === 0, leaked.join(', ') || (await page.locator('h2').first().innerText()));
  check('masked values are readable: initials and the year of birth',
    /A\. V\./.test(shown) && /XX\/XX\/2006/.test(shown) && /Date of birth of A\. V\. differs/.test(shown));
  check('no page image is shown while masking', await page.getByTestId('page-preview').count() === 0);
  check('review controls are off while masking', await page.getByTestId('field-review').count() === 0 && await page.getByTestId('review-approve').count() === 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('f8-masked-document');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export JSON/i }).click()]);
  const exported = readFileSync(await download.path(), 'utf8');
  check('the export is redacted, with a redacted file name',
    /-redacted\.json$/.test(download.suggestedFilename()) && !/asha/i.test(download.suggestedFilename()) && SECRETS.every(x => !exported.includes(x)) && JSON.parse(exported).redacted === true,
    download.suggestedFilename());
  await nav('Graph');
  await page.getByTestId('graph-mode-entities').click();
  await page.getByTestId('graph-canvas').waitFor({ timeout: 10_000 });
  const nodes = (await page.getByTestId('graph-node').allInnerTexts()).join(' | ');
  check('the entity graph is masked too', SECRETS.every(x => !nodes.toLowerCase().includes(x.toLowerCase())) && /A\. V\./.test(nodes), nodes.slice(0, 120));
  await nav('Extract');
  await page.getByTestId('mask-toggle').click();
  await page.getByTestId('mask-banner').waitFor({ state: 'detached', timeout: 10_000 });
  check('turning masking off shows the data again', /Asha Verma/.test(await page.getByTestId('document-screen').innerText()));
}

if (sections.includes('hindi')) {
  step = 'hindi';
  await upload(['g']);
  const subject = page.getByTestId('field-row').filter({ hasText: /Subject \/ title/i });
  check('a Hindi value is shown with its transliteration', /varshik pariksha karyakram/.test(await subject.getByTestId('field-transliteration').innerText()));
  await page.getByTestId('translate').click();
  await page.getByTestId('translation-panel').waitFor({ timeout: 20_000 });
  const panel = await page.getByTestId('translation-panel').innerText();
  const pageText = await page.getByTestId('translation-page').innerText();
  check('the notice is translated to English by the AI', /AI translation/i.test(panel) && /annual examinations? will begin/i.test(pageText) && !/[\u0900-\u097F]/.test(pageText),
    panel.split('\n').slice(0, 3).join(' / '));
  await page.getByTestId('translation-panel').scrollIntoViewIfNeeded();
  await shot('f9-translation');
  await nav('Search');
  await page.getByTestId('mode-search').click();
  await page.getByTestId('search-input').fill('suchna pariksha');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-hit').first().waitFor({ timeout: 10_000 });
  const hits = await page.getByTestId('search-hit').allInnerTexts();
  // The highlighted word is Devanagari (its exact spelling depends on the OCR).
  const marked = await page.locator('[data-testid="search-hit"] mark').allInnerTexts();
  check('a Latin-letter search finds the Hindi words', hits.length > 0 && /Annual Examination/i.test(hits[0]) && marked.some(m => /[\u0900-\u097F]/.test(m)), marked.join(', '));
  await shot('f9-cross-language-search');
}

if (sections.includes('quality')) {
  step = 'quality';
  await nav('Upload');
  await page.getByTestId('file-input').setInputFiles(['k', 'e', 'b'].map(l => asUpload(sample(l))));
  await page.getByTestId('batch-progress').waitFor({ timeout: 10_000 });
  check('a batch shows its overall progress', /\d of 3 done/i.test(await page.getByTestId('batch-progress').innerText()), await page.getByTestId('batch-progress').innerText());
  await page.getByTestId('upload-quality-warning').first().waitFor({ timeout: 10_000 });
  const warning = await page.getByTestId('upload-quality-warning').first().innerText();
  check('the blurry, dark photo is flagged before it is processed', /Blurry photo · Too dark/i.test(warning) && (await page.getByTestId('upload-quality-warning').count()) === 1, warning);
  await shot('f10-batch-upload');
  await page.getByTestId('document-screen').waitFor({ timeout: 120_000 });
  await openDoc('k');
  const issues = await page.getByTestId('issues-panel').innerText();
  check('the document lists the image-quality problems', /Image quality · 2/i.test(issues) && /looks blurry/.test(issues) && /too dark/.test(issues), issues.split('\n').slice(0, 4).join(' / '));
  await page.getByTestId('field-row').filter({ hasText: /Applicant name/i }).click();
  check('and explains the lower confidence of its values', /Capped at 75%: the photo or scan is blurry/.test(await page.getByTestId('source-panel').innerText()));
  await page.getByTestId('issues-panel').scrollIntoViewIfNeeded();
  await shot('f10-quality-issues');
}

if (sections.includes('details')) {
  step = 'details';
  if (!['cross', 'entities', 'review', 'mask'].some(x => sections.includes(x))) await upload(['d', 'i']);
  await nav('Extract');
  await openDoc('i');
  await page.getByRole('button', { name: /Concept Map/i }).click();
  await page.getByTestId('graph-canvas').waitFor({ timeout: 60_000 });
  await nav('Details');
  const summary = page.getByTestId('document-check-summary');
  await summary.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const text = await summary.innerText();
  check('the Details page starts with the validation summary of its document',
    /Student (ID|Identity) Card/i.test(text) && /Date of birth of Asha Verma differs/.test(text) && /Identity document/i.test(text), text.split('\n').slice(0, 4).join(' / '));
  check('the summary sits above the concept-map details', await page.evaluate(() => {
    const s = document.querySelector('[data-testid="document-check-summary"]');
    const h = [...document.querySelectorAll('h3')].find(x => /Prerequisite Roadmap/.test(x.textContent));
    return Boolean(s && h && s.getBoundingClientRect().top < h.getBoundingClientRect().top);
  }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('f12-details-summary');
  await page.getByTestId('summary-open-document').click();
  await page.getByTestId('document-screen').waitFor({ timeout: 10_000 });
  page.once('dialog', d => d.accept());
  const approve = page.getByTestId('review-approve');
  if (/Reopen/i.test(await approve.innerText())) await approve.click();
  await page.getByTestId('review-approve').click();
  await page.getByTestId('review-badge').filter({ hasText: /Approved/i }).waitFor({ timeout: 10_000 });
  await nav('Details');
  await summary.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  check('and shows the review status and the latest audit entries',
    /Approved by features/i.test(await page.getByTestId('summary-review-status').innerText()) && /Approved the document/.test(await page.getByTestId('summary-audit').first().innerText()));
}

check('no console errors or failed requests', problems.length === 0, problems.join('\n'));
writeFileSync(`${out}/verify-features.json`, JSON.stringify({ sections, results, problems }, null, 2));
await browser.close();
process.exitCode = results.every(r => r.ok) ? 0 : 1;

// Responsive check: walks every screen and panel with real (mocked) data, then for each
// viewport width takes a screenshot and lists the elements that stick out of the
// viewport (content cut off by the page's overflow-x clip, or a sideways scroll).
// Usage: node scripts/verify-mobile.mjs [outDir] [--widths=360,390,768] [--states=hero,document] [--layout]
//   --layout  also writes layout-<state>-<width>.json (element boxes) for compare-layout.mjs,
//             to prove a mobile change left the desktop layout as it was.
// Expects the web app on :5173 and scripts/mock-api.mjs on :3001.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, watchPage } from './lib/browser.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const out = args.find(a => !a.startsWith('--')) || 'docs/mobile';
const widths = (flag('widths') || '360,390,768').split(',').map(Number);
const only = flag('states')?.split(',');
const withLayout = args.includes('--layout');
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const DESKTOP = { width: 1440, height: 900 };
mkdirSync(out, { recursive: true });

const samples = JSON.parse(readFileSync(path.join(root, 'samples/manifest.json'), 'utf8'));
const sample = letter => {
  const name = samples.find(m => m.file.startsWith(`${letter}-`)).file;
  return { name, mimeType: /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'application/pdf', buffer: readFileSync(path.join(root, 'samples', name)) };
};

const chromium = await loadChromium();
const browser = await chromium.launch();
const report = [];
let step = 'start';

/** Elements outside the viewport sideways, outermost only, ignoring ones a scroll box or clip inside the page holds. */
function auditOverflow() {
  const vw = document.documentElement.clientWidth;
  const pageRoot = document.querySelector('#root > div');
  const outside = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1);
  };
  const describe = el => {
    const r = el.getBoundingClientRect();
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    const testid = el.closest('[data-testid]')?.getAttribute('data-testid');
    return {
      tag: el.tagName.toLowerCase(),
      testid: testid || null,
      class: cls.slice(0, 160),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
    };
  };
  const found = [];
  const scrollers = [];
  for (const el of document.querySelectorAll('#root *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    if (/blur-\[120px\]/.test(el.getAttribute('class') || '')) continue; // decorative glows
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) scrollers.push(describe(el));
    if (!outside(el)) continue;
    // Held by a clipping or scrolling box that is itself inside the viewport.
    let held = false;
    for (let p = el.parentElement; p && p !== pageRoot && p !== document.body; p = p.parentElement) {
      if (/(hidden|auto|scroll|clip)/.test(getComputedStyle(p).overflowX)) {
        if (!outside(p)) held = true;
        break;
      }
    }
    if (held) continue;
    if (el.parentElement && el.parentElement !== pageRoot && outside(el.parentElement)) continue; // report the outermost
    found.push(describe(el));
  }
  return { viewport: vw, overflow: found, scrollers, pageScroll: document.documentElement.scrollWidth - vw };
}

/** Boxes of all visible elements (for the desktop regression diff); the graph canvas moves by itself. */
function layoutSnapshot() {
  const rows = [];
  let i = 0;
  for (const el of document.querySelectorAll('#root *')) {
    i++;
    if (el.closest('[data-testid="graph-canvas"]')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
    rows.push([i, el.tagName.toLowerCase(), cls.slice(0, 80), Math.round(r.x), Math.round(r.y + window.scrollY), Math.round(r.width), Math.round(r.height)]);
  }
  return rows;
}

async function capture(page, name) {
  if (only && !only.includes(name)) return;
  for (const width of widths) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : width >= 768 ? 1024 : 800 });
    await page.waitForTimeout(1200);
    const audit = await page.evaluate(auditOverflow);
    report.push({ state: name, width, ...audit });
    const flagged = audit.overflow.length ? `  OVERFLOW ${audit.overflow.length}: ${audit.overflow.map(o => `${o.tag}${o.testid ? `[${o.testid}]` : ''} "${o.text.slice(0, 40)}" ${o.left}..${o.right}`).join(' | ')}` : '';
    console.log(`${name.padEnd(22)} ${String(width).padStart(4)}px${flagged}`);
    await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
    if (withLayout) writeFileSync(`${out}/layout-${name}-${width}.json`, JSON.stringify(await page.evaluate(layoutSnapshot)));
  }
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(400);
}

const nav = (page, label) => page.locator('header nav button', { hasText: new RegExp(`^${label}$`) }).click();

// 1. Signed out: empty states and the sign-in dialog.
{
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const problems = watchPage(page, () => `(${step})`);
  await page.goto(WEB);
  step = 'hero';
  await page.waitForTimeout(2600);
  await capture(page, 'hero');
  step = 'auth';
  await page.getByRole('button', { name: 'Sign In' }).first().click();
  await page.waitForTimeout(500);
  await capture(page, 'auth-modal');
  await page.keyboard.press('Escape');
  await page.getByLabel('Close').first().click().catch(() => {});
  for (const [label, name] of [['Upload', 'upload-empty'], ['Extract', 'extract-empty'], ['Graph', 'graph-empty'], ['Details', 'details-empty'], ['Search', 'search-guest']]) {
    step = name;
    await nav(page, label);
    await capture(page, name);
  }
  report.push({ state: 'guest', problems });
  await context.close();
}

// 2. Signed in, with documents, a concept map and searches.
{
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  const problems = watchPage(page, () => `(${step})`);
  await page.goto(WEB);
  const signup = await page.request.post(`${WEB}/api/auth/signup`, { data: { email: `mobile${Date.now()}@example.com`, password: 'secret12', phone: '9876543210', age: 21 } });
  await page.evaluate(t => localStorage.setItem('doxentra_token', t), (await signup.json()).token);
  await page.reload();
  await page.waitForTimeout(1500);

  step = 'account-menu';
  await page.getByRole('button', { name: 'Account menu' }).click();
  await capture(page, 'account-menu');
  await page.getByRole('button', { name: 'Account menu' }).click();

  step = 'upload';
  await nav(page, 'Upload');
  await page.getByTestId('file-input').setInputFiles(['g', 'c', 'a'].map(sample));
  await page.getByTestId('document-screen').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(800);
  await capture(page, 'document');

  step = 'document-source';
  await page.getByTestId('field-row').first().click();
  await page.getByTestId('source-panel').waitFor();
  await capture(page, 'document-source');

  step = 'document-review';
  const correct = page.getByTestId('review-correct');
  if (await correct.count()) {
    await correct.first().click();
    await capture(page, 'document-review');
  }

  step = 'document-masked';
  await page.getByTestId('mask-toggle').click();
  await page.getByTestId('mask-banner').waitFor({ timeout: 10_000 }).catch(() => {});
  await capture(page, 'document-masked');
  await page.getByTestId('mask-toggle').click();
  await page.getByTestId('mask-banner').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

  step = 'document-translation';
  await page.locator('[data-testid="document-screen"] button[aria-pressed]', { hasText: /g-notice/i }).first().click();
  await page.getByTestId('translate').click();
  await page.getByTestId('translation-panel').waitFor({ timeout: 20_000 });
  await capture(page, 'document-translation');

  step = 'upload-after';
  await nav(page, 'Upload');
  await capture(page, 'upload-after');

  step = 'graph-concepts';
  await nav(page, 'Extract');
  await page.locator('[data-testid="document-screen"] button[aria-pressed]', { hasText: /a-invoice/i }).first().click();
  await page.getByRole('button', { name: /Concept Map/ }).click();
  await page.getByTestId('graph-canvas').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await capture(page, 'graph-concepts');

  step = 'graph-node';
  await page.getByTestId('graph-node').first().click({ force: true });
  await page.getByRole('dialog').waitFor({ timeout: 5000 }).catch(() => {});
  await capture(page, 'graph-node');
  await page.keyboard.press('Escape');
  // Escape may close it with an exit animation; only click Close when it stays open.
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').locator('button', { hasText: /Close$/ }).first().click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

  step = 'details';
  await nav(page, 'Details');
  await page.locator('#knowledge-check').waitFor({ timeout: 10_000 }).catch(() => {});
  await capture(page, 'details');

  step = 'graph-entities';
  await nav(page, 'Graph');
  await page.getByTestId('graph-mode-entities').click();
  await page.getByTestId('graph-canvas').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(2500);
  await capture(page, 'graph-entities');

  step = 'history';
  await nav(page, 'History');
  await page.getByTestId('document-card').first().waitFor({ timeout: 10_000 });
  await capture(page, 'history');

  step = 'search-results';
  await nav(page, 'Search');
  await page.getByTestId('mode-search').click();
  await page.getByTestId('search-input').fill('invoice');
  await page.getByTestId('search-input').press('Enter');
  await page.getByTestId('search-hit').first().waitFor({ timeout: 10_000 });
  await capture(page, 'search-results');

  step = 'search-ask';
  await page.getByTestId('mode-ask').click();
  await page.getByTestId('ask-input').fill('What is the invoice total?');
  await page.getByTestId('ask-send').click();
  await page.getByTestId('ask-turn').first().waitFor({ timeout: 30_000 });
  await page.getByTestId('ask-answer').first().waitFor({ timeout: 30_000 }).catch(() => {});
  await capture(page, 'search-ask');

  report.push({ state: 'signed-in', problems });
  await context.close();
}

writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
const bad = report.filter(r => r.overflow?.length);
const problems = report.flatMap(r => r.problems || []);
console.log(`\n${bad.length} state/width pairs with content outside the viewport; ${problems.length} console or network problems.`);
for (const p of problems) console.log(p);
await browser.close();
process.exitCode = bad.length || problems.length ? 1 : 0;

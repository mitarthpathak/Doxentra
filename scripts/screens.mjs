// Captures screenshots of the existing screens for visual regression checks.
// Usage: node scripts/screens.mjs <outDir>   (expects `npm start` running: web :5173, API :3001)
import { mkdirSync, readFileSync } from 'node:fs';
import { loadChromium } from './lib/browser.mjs';

const chromium = await loadChromium();
const out = process.argv[2] || 'docs/baseline';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push(e.message));

const settle = (ms = 1200) => page.waitForTimeout(ms);
async function shot(name) {
  await settle();
  await page.screenshot({ path: `${out}/${name}-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(800);
  await page.screenshot({ path: `${out}/${name}-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(500);
}
const nav = label => page.locator('header nav button', { hasText: new RegExp(`^${label}$`) }).click();

await page.goto(WEB);
await shot('hero');

await page.locator('header button', { hasText: /sign in/i }).first().click();
await settle();
await page.screenshot({ path: `${out}/auth-desktop.png` });
await page.keyboard.press('Escape');
await page.getByLabel('Close').first().click().catch(() => {});

await nav('Upload');
await shot('upload-empty');

// Sign in through the API so the History screen is reachable.
const email = `baseline${Date.now()}@example.com`;
const res = await page.request.post(`${WEB}/api/auth/signup`, { data: { email, password: 'secret12', phone: '1', age: 20 } });
const { token } = await res.json();
await page.evaluate(t => localStorage.setItem('doxentra_token', t), token);
await page.reload();
await nav('Upload');

await page.getByTestId('file-input').setInputFiles({
  name: 'sample.pdf', mimeType: 'application/pdf',
  buffer: readFileSync(new URL('../server/test/fixtures/sample.pdf', import.meta.url)),
});
// Since the document-intelligence redesign an upload opens the extraction
// result; the concept map is one click away from there.
await page.getByTestId('document-screen').or(page.getByText('Semantic Architecture')).first().waitFor({ timeout: 60000 });
const buildMap = page.getByRole('button', { name: /Concept Map/ });
if (await buildMap.count()) await buildMap.click();
await page.locator('text=Semantic Architecture').waitFor({ timeout: 60000 });
await settle(4000);
await shot('graph');

await nav('Upload');
await shot('upload-result');

await nav('Details');
await shot('details');
// The quiz sits at the bottom of the details screen.
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await settle();
await page.screenshot({ path: `${out}/quiz-desktop.png` });

await nav('History');
await shot('history');

console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors');
await browser.close();

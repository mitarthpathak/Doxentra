import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath: process.env.DOXENTRA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/documents', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, documents: [
    { id: 'circular', filename: 'rules.pdf', docType: 'institutional_record', docTypeLabel: 'Letter / notice / record' },
    { id: 'marksheet', filename: 'marksheet.pdf', docType: 'marksheet', docTypeLabel: 'Marksheet' },
  ] }) }));
  await page.route('**/api/packets', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, packets: [] }) }));
  await page.route('**/api/policies/circular', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, policy: { method: 'text_rules', requirements: [
    { id: 'r1', label: 'Submit marksheet', source: { page: 1, line: 3, quote: 'Submit the marksheet.' } },
  ] } }) }));
  await page.goto(process.env.DOXENTRA_UI_URL || 'http://localhost:5173');
  await page.getByRole('button', { name: 'Packets' }).first().click();
  await page.getByTestId('packet-screen').waitFor();
  await page.getByLabel('Case title').fill('Asha application');
  await page.getByText('marksheet.pdf').first().click();
  await page.getByLabel('Institution circular or rule').selectOption('circular');
  await page.getByText('Submit marksheet', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create case' }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('Packet UI smoke passed');
} finally {
  await browser.close();
}

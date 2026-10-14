import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath: process.env.DOXENTRA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).hostname !== 'localhost') external.push(r.url()); });
  const issue = { rule: 'person.dob', type: 'cross_document', severity: 'error', message: 'Dates of birth disagree across these documents.', refs: [
    { documentId: 'a', fieldKey: 'date_of_birth', title: 'PAN Card', filename: 'pan.pdf', docType: 'identity_document', value: '14/03/2006' },
    { documentId: 'b', fieldKey: 'date_of_birth', title: 'Marksheet', filename: 'marksheet.pdf', docType: 'marksheet', value: '15/03/2006' },
  ] };
  const graph = { filename: '', metadata: { title: 'Integrity' }, kind: 'entities', issues: [issue], nodes: [
    { id: 'workspace', type: 'major', label: 'Workspace' },
    { id: 'doc:a', type: 'sub-topic', label: 'PAN Card', documentId: 'a', parentId: 'workspace' },
    { id: 'doc:b', type: 'sub-topic', label: 'Marksheet', documentId: 'b', parentId: 'workspace' },
    ...issue.refs.map((r, i) => ({ id: `field:${r.documentId}:date_of_birth`, type: 'concept', label: `DOB: ${r.value}`, severity: 'error', documentId: r.documentId, fieldKey: r.fieldKey, parentId: `doc:${r.documentId}` })),
  ], edges: [{ source: 'field:a:date_of_birth', target: 'field:b:date_of_birth', kind: 'mismatch', severity: 'error', message: issue.message }] };
  await page.route('**/privacy-ui-check', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/fonts/fonts.css"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    const {ProcessingModeToggle}=await import('/src/components/ProcessingModeToggle.tsx');
    const {GraphScreen}=await import('/src/components/GraphScreen.tsx');
    const {setProcessingBusy}=await import('/src/lib/processingMode.ts');window.setBusy=setProcessingBusy;
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'p-4'},React.createElement(ProcessingModeToggle),React.createElement(ProcessingModeToggle,{compact:true}),React.createElement(GraphScreen,{data:${JSON.stringify(graph)},mode:'entities',viewedNodeIds:new Set(),onNodeExplored:()=>{},onUploadClick:()=>{}})));
  </script></body></html>` }));
  await page.goto(`${process.env.DOXENTRA_UI_URL || 'http://localhost:5173'}/privacy-ui-check`);
  const switches = page.getByRole('switch');
  await switches.first().waitFor();
  assert.equal(await switches.first().getAttribute('aria-checked'), 'false');
  await page.evaluate(() => window.setBusy(true));
  await switches.first().isDisabled().then(value => assert.equal(value, true));
  await page.evaluate(() => window.setBusy(false));
  const reload = page.waitForEvent('load');
  await switches.first().click(); await reload;
  await page.getByRole('switch').first().waitFor();
  assert.equal(await page.getByRole('switch').first().getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('switch').nth(1).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByTestId('conflict-node-badge').count(), 2);
  await page.getByTestId('conflict-item').click();
  assert.equal(await page.getByTestId('conflicting-value').count(), 2);
  await page.getByRole('dialog').getByText('pan.pdf', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('mismatch-edge').focus(); await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.setViewportSize({ width: 375, height: 700 });
  assert.equal(await page.getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
  assert.equal(await page.getByTestId('mismatch-edge').getAttribute('stroke'), '#ef4444');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('PASS: mode persistence/synchronization, upload lock, conflict badges, banner comparison, keyboard edge comparison, mobile dialog, zero external browser requests.');
} finally { await browser.close(); }

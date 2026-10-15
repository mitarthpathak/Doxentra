import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath: process.env.DOXENTRA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const graph = {
    filename: '', metadata: { title: 'People & Documents' },
    nodes: [
      { id: 'workspace', type: 'major', label: 'Your documents' },
      { id: 'person', type: 'header', label: 'MITARTH PATHAK' },
      { id: 'doc', type: 'sub-topic', label: 'CBSE Senior Secondary Examination 2024 Admit Card' },
      { id: 'roll', type: 'concept', label: 'Roll number: 11665914' },
    ],
    edges: [
      { source: 'workspace', target: 'person', label: 'contains' },
      { source: 'person', target: 'doc', label: 'contains' },
      { source: 'doc', target: 'roll', label: 'contains' },
    ],
  };
  await page.route('**/graph-pan-check', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    const {GraphScreen}=await import('/src/components/GraphScreen.tsx');
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'p-4'},React.createElement(GraphScreen,{data:${JSON.stringify(graph)},mode:'entities',viewedNodeIds:new Set(),onNodeExplored:()=>{},onUploadClick:()=>{}})));
  </script></body></html>` }));
  await page.goto(`${process.env.DOXENTRA_UI_URL || 'http://localhost:5173'}/graph-pan-check`);
  const canvas = page.getByTestId('graph-canvas');
  const layer = page.getByTestId('graph-pan-layer');
  await canvas.waitFor();
  await canvas.scrollIntoViewIfNeeded();
  const pan = () => layer.evaluate(el => {
    const matrix = new DOMMatrix(getComputedStyle(el).transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
  async function drag(x, y, dx, dy) {
    const before = await pan();
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(({ before, dx, dy }) => {
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="graph-pan-layer"]')).transform);
      return Math.abs(matrix.m41 - before.x - dx) < 2 && Math.abs(matrix.m42 - before.y - dy) < 2;
    }, { before, dx, dy });
    assert.equal(await page.getByRole('dialog').count(), 0, 'dragging must not open node details');
  }
  async function reset() {
    await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
    await page.waitForFunction(() => {
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector('[data-testid="graph-pan-layer"]')).transform);
      return Math.abs(matrix.m41) < 0.1 && Math.abs(matrix.m42) < 0.1;
    });
  }
  for (const fullscreen of [false, true]) {
    if (fullscreen) await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await reset();
    const box = await canvas.boundingBox();
    await drag(box.x + 70, box.y + 70, 260, 160);
    // This point is outside the translated layer: the viewport must still pan.
    await drag(box.x + 60, box.y + 60, 130, 90);
    await reset();
    const card = page.getByTestId('graph-node').filter({ hasText: 'CBSE Senior Secondary' });
    await card.waitFor({ state: 'visible' });
    const cardBox = await card.boundingBox();
    await drag(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, -90, 60);
    await card.click();
    await page.getByRole('dialog', { name: graph.nodes[2].label, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await reset();
    const before = await pan();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    const after = await pan();
    assert.ok(Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1, 'zoom controls must not start a pan');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: repeated panning across the full viewport, dragging from cards, node clicks, zoom controls, normal and full-screen views.');
} finally {
  await browser.close();
}

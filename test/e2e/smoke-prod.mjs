// Smoke test of the real build (dist/): minified, closed shadow root, no test
// hooks. Opens the panel the same way the toolbar button does and checks that
// the form gets filled.   npm run smoke

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { startServer } from './server.mjs';
import { chromePath } from './chrome.mjs';
import { PROFILE } from '../fixtures/profile.mjs';

const PORT = 4458;
const BASE = `http://127.0.0.1:${PORT}`;
const server = await startServer(PORT);
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, enableExtensions: [path.resolve('dist')], pipe: true, defaultViewport: { width: 1360, height: 900 } });
let ok = false;
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'));
  const sw = await swTarget.worker();
  const hookFree = await sw.evaluate(() => typeof globalThis.fillaiTest === 'undefined');
  await sw.evaluate(
    async (cfg) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(cfg);
    },
    { settings: { apiKey: 'test-key', baseURL: BASE }, profile: PROFILE, facts: [] },
  );
  const page = await browser.newPage();
  await page.goto(`${BASE}/fixtures/job-form.html?smoke`);
  await new Promise((r) => setTimeout(r, 500));
  // Exactly what the toolbar button does.
  await sw.evaluate(async (u) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url?.includes(u));
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__fillai?.togglePanel() });
  }, '?smoke');
  await page.waitForFunction(() => document.getElementById('first').value === 'Asha', { timeout: 30000 });
  const closed = await page.evaluate(() => document.getElementById('fillai-root')?.shadowRoot === null);
  ok = hookFree && closed;
  console.log(`production build: filled the form ✓, test hooks absent ${hookFree ? '✓' : '✗'}, panel shadow root closed to the page ${closed ? '✓' : '✗'}`);
} catch (err) {
  console.error('smoke test failed:', err.message);
} finally {
  await browser.close();
  server.close();
}
process.exit(ok ? 0 : 1);

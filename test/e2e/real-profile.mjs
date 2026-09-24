// Build a profile from a real resume with the local Ollama model, through the
// real settings page. Nothing leaves this computer. Prints what was read and
// how long it took.
//   node build.mjs --test && node test/e2e/real-profile.mjs <resume.pdf> [model]

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { chromePath } from './chrome.mjs';

const pdf = process.argv[2];
const model = process.argv[3] || 'qwen3.5:4b';
if (!pdf) throw new Error('usage: real-profile.mjs <resume.pdf> [model]');

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: !process.env.HEADFUL, enableExtensions: [path.resolve(process.env.DIST || 'dist-test')], pipe: true, protocolTimeout: 1200000, defaultViewport: { width: 1360, height: 900 } });
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'));
  const sw = await swTarget.worker();
  await sw.evaluate(async (m) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ settings: { provider: 'ollama', ollamaModel: m } });
  }, model);
  const opt = await browser.newPage();
  opt.on('dialog', (d) => d.accept());
  opt.on('console', (m) => m.type() === 'warn' && console.log('page warning:', m.text()));
  await opt.goto(`chrome-extension://${new URL(swTarget.url()).host}/options.html`);
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('ollamaStatus').className), { timeout: 20000 });
  console.log(await opt.$eval('#ollamaStatus', (e) => e.textContent));
  await (await opt.$('#files')).uploadFile(path.resolve(pdf));
  await opt.waitForFunction(() => document.querySelectorAll('#fileList li').length === 1);
  const t0 = Date.now();
  await opt.click('#build');
  const tick = setInterval(async () => console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s`, await opt.$eval('#buildStatus', (e) => e.textContent).catch(() => '')), 15000);
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('buildStatus').className), { timeout: 900000, polling: 1000 });
  clearInterval(tick);
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s:`, await opt.$eval('#buildStatus', (e) => e.textContent));
  const profile = await sw.evaluate(async () => (await chrome.storage.local.get('profile')).profile);
  if (profile) {
    const counts = Object.fromEntries(Object.entries(profile).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
    console.log('basics:', JSON.stringify(profile.basics));
    console.log('links:', JSON.stringify(profile.links));
    console.log('counts:', JSON.stringify(counts));
    console.log('education:', JSON.stringify(profile.education.map((e) => [e.institution, e.degree, e.start, e.end, e.grade])));
    console.log('experience:', JSON.stringify(profile.experience.map((e) => [e.company, e.title, e.start, e.end, e.is_current])));
    console.log('projects:', JSON.stringify(profile.projects.map((p) => p.name)));
  }
} finally {
  await browser.close();
}

// The real thing on this computer: the extension, the local Ollama model and
// the fixture job form. Only the page is fake. Prints what landed in each
// field and how long it took, once per effort level.
//   node build.mjs --test && node test/e2e/real-ollama.mjs [model] [effort...]

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startServer } from './server.mjs';
import { chromePath } from './chrome.mjs';
import { PROFILE } from '../fixtures/profile.mjs';

const model = process.argv[2] || 'qwen3.5:4b';
const efforts = process.argv.slice(3).length ? process.argv.slice(3) : ['medium', 'high'];
const PORT = 4461;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('test/e2e/out');
mkdirSync(OUT, { recursive: true });

const server = await startServer(PORT);
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: !process.env.HEADFUL, enableExtensions: [path.resolve('dist-test')], pipe: true, defaultViewport: { width: 1360, height: 900 } });
try {
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'))).worker();
  for (const effort of efforts) {
    await sw.evaluate(
      async (cfg) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set(cfg);
      },
      { settings: { provider: 'ollama', ollamaURL: 'http://localhost:11434', ollamaModel: model, effort }, profile: PROFILE, facts: [], resumeFile: { name: 'Asha_Verma_Resume.pdf', type: 'application/pdf', size: 20, data: 'JVBERi0xLjQKJSVFT0YK' } },
    );
    const page = await browser.newPage();
    await page.goto(`${BASE}/fixtures/job-form.html?real=${effort}`);
    await new Promise((r) => setTimeout(r, 500));
    await page.bringToFront();
    const t0 = Date.now();
    await sw.evaluate((u) => fillaiTest.openPanel(u), page.url());
    await page.waitForFunction(() => document.querySelector('#fillai-root')?.shadowRoot?.querySelector('.chips, .hero h2:not(:empty)') && !document.querySelector('#fillai-root').shadowRoot.querySelector('.orb'), { timeout: 600000, polling: 500 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const v = await page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      return {
        first: $('first').value, last: $('last').value, email: $('email').value, phone: $('phone').value, city: $('city').value,
        degree: $('degree').value, grad: $('grad').value, college: $('college').value, li: $('li').value, gh: $('gh').value,
        skills: [...document.querySelectorAll('[name="skills[]"]:checked')].map((c) => c.value).join(','),
        k8s: $('k8s').value, notice: $('notice').value, cv: $('cv').files[0]?.name ?? '', gender: $('gender').value, consent: $('consent').checked,
        relocate: [...document.querySelectorAll('[name=relocate]')].find((r) => r.checked)?.value ?? '', submits: window.__submits || 0,
      };
    });
    const panel = await page.evaluate(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.body').innerText.replace(/\n+/g, ' | ').slice(0, 1400));
    const meta = await page.evaluate(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.meta').textContent);
    console.log(`\n=== ${model}, effort ${effort}: ${secs}s ===`);
    console.log(v);
    console.log('meta:', meta);
    console.log('panel:', panel);
    await page.screenshot({ path: path.join(OUT, `real-ollama-${effort}.png`) });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

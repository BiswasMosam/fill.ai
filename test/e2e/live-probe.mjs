// Try Fill.ai on a real website with the mock AI. Nothing is ever submitted:
// the extension never presses submit, and this script closes the browser.
//   node build.mjs --test && node test/e2e/live-probe.mjs <url> [name]

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startServer, requests } from './server.mjs';
import { chromePath } from './chrome.mjs';
import { PROFILE } from '../fixtures/profile.mjs';

const url = process.argv[2];
const name = process.argv[3] || 'live';
if (!url) throw new Error('usage: live-probe.mjs <url> [name]');
const PORT = 4457;
const OUT = path.resolve('test/e2e/out');
mkdirSync(OUT, { recursive: true });

const server = await startServer(PORT);
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: !process.env.HEADFUL,
  enableExtensions: [path.resolve('dist-test')],
  pipe: true,
  defaultViewport: { width: 1360, height: 900 },
});
try {
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
  await sw.evaluate(
    async (cfg) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(cfg);
    },
    { settings: { provider: 'ollama', ollamaURL: `http://127.0.0.1:${PORT}`, ollamaModel: 'qwen3.5:4b', effort: 'medium' }, profile: PROFILE, facts: [], resumeFile: { name: 'Asha_Verma_Resume.pdf', type: 'application/pdf', size: 20, data: 'JVBERi0xLjQKJSVFT0YK' } },
  );
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.bringToFront();
  const y0 = await page.evaluate(() => scrollY);
  await page.evaluate(() => { window.__scrolls = []; addEventListener('scroll', () => window.__scrolls.push(Math.round(scrollY) + '@' + Math.round(performance.now())), { passive: true }); });
  await sw.evaluate((u) => fillaiTest.openPanel(u), page.url());
  await page.waitForFunction(() => document.querySelector('#fillai-root')?.shadowRoot?.querySelector('.chips, .hero h2'), { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  console.log('scrollY before', y0, 'after', await page.evaluate(() => scrollY), 'trail', (await page.evaluate(() => window.__scrolls)).slice(-12).join(' '));
  const req = requests.find((r) => r.path === '/api/chat');
  if (req) {
    const form = JSON.parse(req.body.messages[1].content.split('<form>\n')[1].split('\n</form>')[0]);
    console.log(`page: ${form.page?.title}\n${form.fields.length} fields sent:`);
    for (const f of form.fields) console.log(' ', f.id.padEnd(6), f.kind.padEnd(10), JSON.stringify(f.label).slice(0, 70), f.options ? `[${f.options.length} options]` : '', f.guard ? `guard=${f.guard}` : '');
  }
  console.log('\n---- panel\n' + (await page.evaluate(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.body').textContent.replace(/\s+/g, ' ').slice(0, 1500))));
  await page.screenshot({ path: path.join(OUT, `live-${name}.png`) });
  console.log(`\nscreenshot: test/e2e/out/live-${name}.png`);
} finally {
  await browser.close();
  server.close();
}

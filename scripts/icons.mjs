// Renders the fill.ai logo to the PNG sizes Chrome wants, using the local
// Chrome in headless mode. Run once after changing the logo:
//   node scripts/icons.mjs
import puppeteer from 'puppeteer-core';
import { chromePath } from '../test/e2e/chrome.mjs';

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>
<rect width="24" height="24" rx="7" fill="url(#g)"/>
<path d="M14.6 6.4h-1.9a2.6 2.6 0 0 0-2.6 2.6v9.2M7.9 11.6h5.2" stroke="#fff" stroke-width="${size <= 16 ? 2.6 : 2.1}" stroke-linecap="round" fill="none"/>
<circle cx="16.6" cy="16.4" r="${size <= 16 ? 2 : 1.7}" fill="#fff"/></svg>`;

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  await page.screenshot({ path: `static/icons/icon${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log('icons written to static/icons/');

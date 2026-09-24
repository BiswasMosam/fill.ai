// Builds what a friend downloads and the page they download it from.
//   node scripts/site.mjs
//
//   release/fill-ai.zip   the production build, files at the top level so
//                         "Extract All" gives a folder Chrome can load as is
//   _site/                the download page, published by GitHub Pages at
//                         www.mosambiswas.com/fill.ai/
//
// The zip itself is published as a GitHub Release, not inside _site: the
// portfolio's service worker controls every path on mosambiswas.com and
// serves zips cache first, so a zip on the site would stay stale for anyone
// who has visited the portfolio. A release lives on github.com, which that
// worker leaves alone. See .github/workflows/publish.yml.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));

// ------------------------------------------------------------------ the zip

function filesOf(dir, base = dir) {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, filesOf(full, base));
    else out[path.relative(base, full).split(path.sep).join('/')] = new Uint8Array(readFileSync(full));
  }
  return out;
}

const files = filesOf('dist');
if (!files['manifest.json']) throw new Error('dist/manifest.json is missing. The build failed.');
rmSync('release', { recursive: true, force: true });
mkdirSync('release');
const zip = zipSync(files, { level: 9 });
writeFileSync('release/fill-ai.zip', zip);

// ------------------------------------------------------------------ the page

const mb = (zip.length / 1e6).toFixed(1);
rmSync('_site', { recursive: true, force: true });
cpSync('site', '_site', { recursive: true });
mkdirSync('_site/img', { recursive: true });
for (const img of ['panel.png', 'settings.png', 'google-forms.png']) cpSync(`docs/${img}`, `_site/img/${img}`);
for (const size of [32, 128]) cpSync(`static/icons/icon${size}.png`, `_site/img/icon${size}.png`);

const html = readFileSync('_site/index.html', 'utf8').replaceAll('{{VERSION}}', version).replaceAll('{{SIZE}}', `${mb} MB`);
if (/\{\{\w+\}\}/.test(html)) throw new Error(`Unfilled placeholder in site/index.html: ${html.match(/\{\{\w+\}\}/)[0]}`);
writeFileSync('_site/index.html', html);

console.log(`fill.ai ${version}: release/fill-ai.zip (${mb} MB, ${Object.keys(files).length} files) and _site/`);

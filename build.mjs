// Bundles the extension into dist/ (load that folder unpacked in Chrome).
//   node build.mjs          one-off build
//   node build.mjs --watch  rebuild on change
//   node build.mjs --test   test build: open shadow root + test hooks, used by test/e2e
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const outdir = test ? 'dist-test' : 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('static', outdir, { recursive: true });
// pdf.js reads resumes for local models in a worker of its own.
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', `${outdir}/pdf.worker.min.mjs`);

const options = {
  entryPoints: {
    background: 'src/background/index.js',
    content: 'src/content/index.js',
    options: 'src/options/options.js',
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  legalComments: 'none',
  minify: !watch && !test,
  sourcemap: watch || test ? 'inline' : false,
  define: { __TEST__: String(test) },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log(`watching, output in ${outdir}/`);
} else {
  await esbuild.build(options);
}

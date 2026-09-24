// Turn a PDF into plain text for AIs that can't read PDFs (local models).
// Runs pdf.js in this page, so the resume never leaves the computer.
//
// Resumes often hide the real address behind a word ("LinkedIn", "GitHub"),
// so link targets are collected from the annotations and listed at the end.

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { pageText } from './pdf-lines.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

export async function pdfText(base64) {
  const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const pages = [];
    const links = new Set();
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      pages.push(pageText((await page.getTextContent()).items));
      for (const a of await page.getAnnotations()) {
        if (a.subtype === 'Link' && /^(https?:|mailto:)/i.test(a.url || '')) links.add(a.url);
      }
    }
    let text = pages.filter(Boolean).join('\n\n');
    if (links.size) text += `\n\nLinks in this PDF:\n${[...links].map((u) => `- ${u}`).join('\n')}`;
    return text;
  } finally {
    task.destroy();
  }
}

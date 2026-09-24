// Lay out pdf.js text items as plain lines. Kept apart from pdf-text.js so it
// can be tested without a browser.

// Tracked capitals ("M O S A M", common in designed resumes) come out of
// pdf.js with a space between every letter, while real word breaks arrive
// as separate items. So inside one item, a run of single characters split by
// single spaces is one word.
export function unspace(str) {
  return str
    .split(/ {2,}/)
    .map((w) => (/^(\S )+\S$/.test(w) ? w.replace(/ /g, '') : w))
    .join(' ');
}

// Resumes are laid out in columns: a title on the left, its dates on the
// right, a big name beside the contact details. Text on one baseline with a
// wide gap between is marked " | " so the model doesn't read it as one
// phrase ("MOSAM MOSAMBISWAS999@GMAIL.COM" was read as a full name).
const COLUMN_GAP = 2.5; // in text heights

export function pageText(items) {
  let out = '';
  let prev = null; // last item with visible text
  let space = 0; // widest blank item since then; pdf.js spans columns with one
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const [, , , , x, y] = item.transform;
    if (!item.str.trim()) {
      space = Math.max(space, item.width || 1);
      // pdf.js opens each new block with an empty item on the block's own
      // baseline. Keep that as a blank line between blocks.
      if (item.hasEOL && prev && Math.abs(y - prev.y) > 2) out = `${out.replace(/\n*$/, '')}\n\n`;
      else if (item.hasEOL && !out.endsWith('\n')) out += '\n';
      continue;
    }
    const h = item.height || 0;
    if (prev && Math.abs(y - prev.y) > 2) {
      if (!out.endsWith('\n')) out += '\n';
    } else if (prev && !out.endsWith('\n')) {
      const gap = Math.max(x - prev.end, space);
      const unit = Math.min(...[h, prev.h].filter(Boolean), Infinity);
      if (gap > COLUMN_GAP * (unit === Infinity ? 6 : unit)) out += ' | ';
      else if (gap > 1.5 || space) out += ' ';
    }
    out += unspace(item.str);
    if (item.hasEOL) out += '\n';
    prev = { y, end: x + (item.width || 0), h };
    space = 0;
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

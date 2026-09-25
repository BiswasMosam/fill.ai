// Dates in forms come in every shape: 2004-07-20, 20/07/2004, 20/07/04,
// July 20, 2004. Fill.ai keeps one shape internally (YYYY-MM-DD) and writes
// whatever shape the field asks for, so a small model never has to.

import { clean } from './text.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "DD/MM/YYYY", "mm-dd-yy", "YYYY.MM.DD", or a mask such as "00/00/0000".
const TOKEN = '(dd|mm|yyyy|yy|d|m|0{2}|0{4}|9{2}|9{4})';
const FORMAT_RE = new RegExp(`(?:^|[^a-z0-9])${TOKEN}([/.\\- ])${TOKEN}\\2${TOKEN}(?![a-z0-9])`, 'i');

const DATE_LABEL = /\b(date|dob|d\.o\.b\.?|birthday|birth ?date|born)\b/i;

export function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function validDay(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000 && y <= 9999)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 04 -> 2004, 98 -> 1998. Anything up to this year's two digits is this century.
export function fullYear(yy) {
  const now = new Date().getFullYear();
  const pivot = now % 100;
  const century = now - pivot;
  return yy <= pivot ? century + yy : century - 100 + yy;
}

// What date format a field asks for, from its placeholder, mask, label or
// hint text. Returns { order: 'DMY' | 'MDY' | 'YMD', sep, year: 2 | 4 } or null.
export function detectFormat(...texts) {
  for (const text of texts) {
    const m = FORMAT_RE.exec(String(text || ''));
    if (!m) continue;
    const parts = [m[1], m[3], m[4]].map((p) => p.toLowerCase());
    const sep = m[2];
    let order;
    if (parts.every((p) => /^[0-9]+$/.test(p))) {
      // A mask only says how many digits go where: a 4-digit group is the
      // year, and day-first is the world's default for the rest.
      order = parts[0].length === 4 ? 'YMD' : 'DMY';
    } else {
      order = parts.map((p) => p[0].toUpperCase()).join('');
    }
    if (!['DMY', 'MDY', 'YMD'].includes(order)) continue;
    const yearPart = parts[order.indexOf('Y')];
    return { order, sep, year: yearPart.length === 2 ? 2 : 4 };
  }
  return null;
}

export function formatName(fmt) {
  if (!fmt) return '';
  const tok = { D: 'DD', M: 'MM', Y: fmt.year === 2 ? 'YY' : 'YYYY' };
  return fmt.order
    .split('')
    .map((c) => tok[c])
    .join(fmt.sep);
}

// Is this a question whose answer is a date?
export function isDateField(field) {
  if (!field) return false;
  if (field.kind === 'date') return true;
  if (!['text', 'textarea', 'tel', 'number', 'combobox'].includes(field.kind)) return false;
  if (field.format?.date) return true;
  return DATE_LABEL.test(`${field.label || ''} ${field.placeholder || ''}`);
}

// Read a date written almost any way. `order` settles 03/04/2005; without it
// such a date is refused rather than guessed. Returns { y, m, d } or null.
export function parseDate(text, order = '') {
  const s = clean(text).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})(?:[t ].*)?$/);
  if (m) return ok(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = m[3].length === 2 ? fullYear(+m[3]) : +m[3];
    if (order === 'YMD') return null;
    if (a > 12 && b <= 12) return ok(y, b, a);
    if (b > 12 && a <= 12) return ok(y, a, b);
    if (a === b) return ok(y, a, b);
    if (order === 'MDY') return ok(y, a, b);
    if (order === 'DMY') return ok(y, b, a);
    return null;
  }

  // Digits only: 20072004, 200704, 20040720.
  m = s.match(/^\d{6}$|^\d{8}$/);
  if (m && order) {
    const digits = m[0];
    const yl = digits.length === 8 ? 4 : 2;
    const cut = { DMY: [2, 2, yl], MDY: [2, 2, yl], YMD: [yl, 2, 2] }[order];
    const parts = [];
    let at = 0;
    for (const w of cut) {
      parts.push(+digits.slice(at, at + w));
      at += w;
    }
    const [p1, p2, p3] = parts;
    const fix = (y) => (yl === 2 ? fullYear(y) : y);
    if (order === 'DMY') return ok(fix(p3), p2, p1);
    if (order === 'MDY') return ok(fix(p3), p1, p2);
    return ok(fix(p1), p2, p3);
  }

  // 20 July 2004, July 20, 2004, 20-Jul-2004.
  m = s.match(/^(\d{1,2})[\s\-/.]+([a-z]+)\.?[\s\-/.,]+(\d{4})$/);
  if (m) return ok(+m[3], monthOf(m[2]), +m[1]);
  m = s.match(/^([a-z]+)\.?[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{4})$/);
  if (m) return ok(+m[3], monthOf(m[1]), +m[2]);
  return null;
}

function monthOf(word) {
  const i = MONTHS.indexOf(word.slice(0, 3));
  return i === -1 ? 0 : i + 1;
}

function ok(y, m, d) {
  return validDay(y, m, d) ? { y, m, d } : null;
}

export function toISO(date) {
  return date ? `${date.y}-${pad(date.m)}-${pad(date.d)}` : '';
}

export function sameDate(a, b) {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}

export function formatDate(date, fmt) {
  if (!date) return '';
  if (!fmt) return toISO(date);
  const part = { D: pad(date.d), M: pad(date.m), Y: fmt.year === 2 ? pad(date.y % 100) : String(date.y) };
  return fmt.order
    .split('')
    .map((c) => part[c])
    .join(fmt.sep);
}

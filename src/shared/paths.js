// Source paths: every answer Claude fills must cite where in the profile it
// came from ("education[0].institution", "facts[2]"). These helpers resolve
// those paths so the code, not the model, decides whether a citation is real.

import { SECTION_TITLES } from './schema.js';

export function tokens(path) {
  const clean = String(path || '')
    .trim()
    .replace(/^(profile|\$)\.?/, '');
  return clean.match(/[^.[\]\s]+/g) || [];
}

export function resolvePath(root, path) {
  const parts = tokens(path);
  if (!parts.length) return undefined;
  let cur = root;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[/^\d+$/.test(part) ? Number(part) : part];
  }
  return cur;
}

export function hasContent(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return false;
}

// Flatten whatever a path points at into plain text, for evidence checks.
export function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (typeof value === 'object') return Object.values(value).map(textOf).join(' ');
  return '';
}

// "education[0].institution" -> "Education · RAIT" style chip text.
export function describePath(root, path) {
  const parts = tokens(path);
  if (!parts.length) return '';
  const section = SECTION_TITLES[parts[0]] || parts[0];
  if (parts.length === 1) return section;
  if (parts[0] === 'facts') {
    const fact = resolvePath(root, `facts[${parts[1]}]`);
    return fact ? `Saved answer · ${truncate(fact.question, 40)}` : section;
  }
  if (/^\d+$/.test(parts[1])) {
    const item = resolvePath(root, `${parts[0]}[${parts[1]}]`);
    const name = item && (item.institution || item.company || item.name || item.title || item.role || item.label || item.language || item.category);
    return name ? `${section} · ${truncate(name, 40)}` : section;
  }
  return `${section} · ${parts[parts.length - 1].replace(/_/g, ' ')}`;
}

function truncate(text, n) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

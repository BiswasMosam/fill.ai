// Small text helpers shared by the page scripts and the background.

export function clean(text) {
  return String(text ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function norm(text) {
  return clean(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Pick the option that matches `wanted`. Exact (normalised) first, then a
// unique prefix, then a unique containment. Ambiguity returns -1 on purpose:
// a wrong choice is worse than asking.
export function matchOption(options, wanted) {
  const w = norm(wanted);
  if (!w) return -1;
  const normed = options.map(norm);
  let i = normed.indexOf(w);
  if (i !== -1) return i;
  const starts = normed.map((o, idx) => (o.startsWith(w) || w.startsWith(o) ? idx : -1)).filter((idx) => idx !== -1 && normed[idx]);
  if (starts.length === 1) return starts[0];
  const contains = normed.map((o, idx) => (o && (o.includes(w) || w.includes(o)) ? idx : -1)).filter((idx) => idx !== -1);
  if (contains.length === 1) return contains[0];
  return -1;
}

export function digits(text) {
  return String(text ?? '').replace(/\D+/g, '');
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

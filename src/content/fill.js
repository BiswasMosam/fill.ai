// Puts answers into the page the way a person would, so React, Angular and
// Google Forms all notice. Every fill is read back; anything that did not
// stick is reported instead of assumed.

import { answerKey, currentOf, entry, isOn, written } from './scan.js';
import { clean, digits, matchOption, norm } from '../shared/text.js';
import { formatDate, parseDate, sameDate } from '../shared/dates.js';
import {
  closePopup,
  controlText,
  deepActive,
  keepScroll,
  openOptions,
  optionText,
  realClick,
  setNativeValue,
  sleep,
  typeKeys,
  visibleOptions,
  waitFor,
} from './dom.js';

const snapshots = new Map(); // id -> how the field looked before Fill.ai touched it

// ---------------------------------------------------------------- primitives

function typeInto(el, value, { blur = true } = {}) {
  el.focus({ preventScroll: true });
  setNativeValue(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (blur) {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    el.blur();
  }
}

function toggle(el) {
  if (el.tagName === 'INPUT') el.click();
  else realClick(el);
}

function findOption(control, wanted, before) {
  const opts = openOptions(control, before);
  const i = matchOption(opts.map(optionText), wanted);
  return i === -1 ? null : opts[i];
}

// Did the control end up showing the option we clicked? "+91" for
// "India +91" counts; an unrelated value or the placeholder does not.
function stuck(control, picked) {
  const shown = norm(controlText(control));
  const want = norm(picked);
  if (!shown) return true; // nothing readable to check against
  return shown.includes(want) || want.includes(shown);
}

// How close is what the page kept to what was typed?
//   ok    - the same, or the same after the page's own formatting
//   close - trimmed or decorated ("https://" dropped, a suffix added)
//   bad   - something else
function judge(got, want) {
  if (got === want) return 'ok';
  if (!got) return 'empty';
  const g = norm(got);
  const w = norm(want);
  if (g === w) return 'ok';
  if (/\d/.test(want) && digits(got) === digits(want) && digits(want).length >= 3) return 'ok';
  if (g && w && (g.includes(w) || (w.includes(g) && g.length >= w.length * 0.6))) return 'close';
  return 'bad';
}

// ---------------------------------------------------------------- per kind

// Listboxes and button dropdowns: open, click the option, check it.
async function pickFromPopup(control, wanted) {
  const before = visibleOptions();
  realClick(control);
  const opt = await waitFor(() => findOption(control, wanted, before), 1800);
  if (!opt) {
    await closePopup(control, before);
    return 'Could not find that option in the list.';
  }
  const text = optionText(opt);
  realClick(opt);
  if (control.getAttribute('role') === 'listbox') {
    // Google Forms marks the chosen option; wait for it rather than assume.
    const took = await waitFor(() => {
      const sel = control.querySelector('[role="option"][aria-selected="true"]');
      return sel ? norm(optionText(sel)) === norm(text) : stuck(control, text);
    }, 1200);
    if (openOptions(control, before).length) await closePopup(control, before);
    return took ? '' : 'The page would not take that option.';
  }
  await sleep(250);
  return stuck(control, text) ? '' : 'The page would not take that option.';
}

// Search-as-you-type comboboxes (react-select and friends): open first, pick
// straight away if the option is on screen, otherwise type to narrow it down.
async function fillCombobox(el, wanted) {
  const before = visibleOptions();
  realClick(el);
  let opt = await waitFor(() => findOption(el, wanted, before), 600);
  if (!opt && !el.readOnly) {
    typeInto(el, wanted, { blur: false });
    opt = await waitFor(() => findOption(el, wanted, before), 2500);
  }
  if (!opt) {
    if (el.value) typeInto(el, '', { blur: false });
    await closePopup(el, before);
    return 'No matching option in the list.';
  }
  const text = optionText(opt);
  realClick(opt);
  await sleep(250);
  if (openOptions(el, before).length) await closePopup(el, before);
  else el.blur();
  return stuck(el, text) ? '' : 'The page would not take that option.';
}

// ---------------------------------------------------------------- native and enhanced selects

function liveOptions(select) {
  return [...select.options]
    .map((o, index) => ({ text: clean(o.textContent) || o.value, value: o.value, index, placeholder: !o.value && /^(select|choose|pick|please|--|—|-|\s*$)/i.test(clean(o.textContent)) }))
    .filter((o) => !o.placeholder && (o.text || o.value));
}

function chosen(select) {
  return [...select.selectedOptions].map((o) => norm(o.textContent || o.value));
}

// Set a native <select> the way its own change handler expects. Select2 and
// Chosen listen for exactly this and redraw their box.
// Returns the (normalised) texts it picked, or null when nothing matched.
function setSelect(el, opts, wanted) {
  const texts = opts.map((o) => o.text);
  const picks = [...new Set(wanted.map((v) => matchOption(texts, v)).filter((i) => i !== -1))];
  if (!picks.length || (!el.multiple && picks.length > 1)) return null;
  if (el.multiple) {
    opts.forEach((o, i) => (el.options[o.index].selected = picks.includes(i)));
  } else {
    setNativeValue(el, opts[picks[0]].value);
    el.selectedIndex = opts[picks[0]].index;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('chosen:updated', { bubbles: true }));
  return picks.map((i) => norm(texts[i]));
}

function widgetShows(widget, texts) {
  const shown = norm(widget.textContent);
  return texts.every((t) => shown.includes(t));
}

async function fillSelect(item, value, values) {
  const { el } = item;
  const opts = liveOptions(el);
  const wanted = el.multiple ? (values.length ? values : [value].filter(Boolean)) : [value];
  const took = (picked) => picked && picked.every((t) => chosen(el).includes(t));
  if (!item.widget) {
    el.focus({ preventScroll: true });
    const picked = setSelect(el, opts, wanted);
    el.blur();
    if (!picked) return 'No matching option.';
    return took(picked) ? '' : 'The page would not take that option.';
  }
  // Select2 and friends: the hidden select first, then check the box they
  // draw agrees. A list that only loads as you type needs the box itself.
  const picked = setSelect(el, opts, wanted);
  if (took(picked)) {
    await sleep(60);
    if (widgetShows(item.widget, picked)) return '';
  }
  if (el.multiple) return 'Pick these in the list yourself.';
  return pickInWidget(item, value);
}

async function pickInWidget(item, wanted) {
  const { el, widget } = item;
  const control = widget.querySelector('[role="combobox"], [aria-haspopup], button, input:not([type="hidden"])') || widget;
  const before = visibleOptions();
  realClick(control);
  let opt = await waitFor(() => findOption(control, wanted, before), 700);
  if (!opt) {
    // Most of these open a search box and put the cursor in it.
    const active = deepActive();
    const search = active?.tagName === 'INPUT' && active !== el ? active : widget.querySelector('input:not([type="hidden"])');
    if (search) {
      typeInto(search, wanted, { blur: false });
      opt = await waitFor(() => findOption(search, wanted, before) || findOption(control, wanted, before), 3000);
    }
  }
  if (!opt) {
    await closePopup(control, before);
    pressEscapeIn(control);
    return 'Could not find that option in the list.';
  }
  const text = optionText(opt);
  realClick(opt);
  const took = await waitFor(() => chosen(el).includes(norm(text)) || widgetShows(widget, [norm(text)]), 1500);
  if (openOptions(control, before).length) await closePopup(control, before);
  return took ? '' : 'The page would not take that option.';
}

function pressEscapeIn(el) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, composed: true }));
}

// ---------------------------------------------------------------- text and dates

async function fillText(el, value) {
  typeInto(el, value);
  await sleep(0);
  let verdict = judge(el.value, value);
  // A masked or otherwise fussy input: type it the way a keyboard would.
  if ((verdict === 'bad' || verdict === 'empty') && (await typeKeys(el, value))) {
    await sleep(0);
    verdict = judge(el.value, value);
  }
  if (verdict === 'ok' || verdict === 'close') return '';
  if (!el.value) return 'The page cleared the value.';
  return `The page changed it to "${clean(el.value).slice(0, 40)}". Check it.`;
}

// The field's own date format when it states one. Otherwise day first with
// a 4-digit year, then with 2 digits: a mask built for "20/07/04" turns
// "20/07/2004" into 20 July 2020, and reading it back catches that.
const GUESSES = [
  { order: 'DMY', sep: '/', year: 4 },
  { order: 'DMY', sep: '/', year: 2 },
];

async function fillDate(item, iso) {
  const { el } = item;
  const want = parseDate(iso, 'YMD');
  if (!want) return fillText(el, iso);
  if (el.type === 'date') return fillText(el, iso);
  for (const fmt of item.dateFormat ? [item.dateFormat] : GUESSES) {
    const text = formatDate(want, fmt);
    typeInto(el, text);
    await sleep(0);
    if (sameDate(parseDate(el.value, fmt.order), want)) return { error: '', shown: el.value };
    await typeKeys(el, text);
    await sleep(0);
    if (sameDate(parseDate(el.value, fmt.order), want)) return { error: '', shown: el.value };
  }
  if (!el.value) return 'The page would not take the date.';
  return `The page changed the date to "${clean(el.value).slice(0, 20)}". Check it.`;
}

async function fillRichText(el, value) {
  // Only type where the cursor really is. execCommand writes into whatever
  // holds the selection, and a field that can't take focus would send the
  // text somewhere else on the page.
  if (!el.isContentEditable) return 'Fill.ai cannot type into this field.';
  el.focus({ preventScroll: true });
  const active = deepActive();
  if (active !== el && !el.contains(active)) return 'Could not put the cursor in this field.';
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand('insertText', false, value);
  if (!ok || clean(el.innerText) !== clean(value)) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }
  el.blur();
  return clean(el.innerText) === clean(value) ? '' : 'The page would not take the text.';
}

async function attachResume(el) {
  const { resumeFile } = await chrome.storage.local.get('resumeFile');
  if (!resumeFile?.data) return 'No resume file saved in Fill.ai.';
  const bytes = Uint8Array.from(atob(resumeFile.data), (c) => c.charCodeAt(0));
  const file = new File([bytes], resumeFile.name || 'resume.pdf', { type: resumeFile.type || 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.files.length ? '' : 'The page would not take the file.';
}

function snapshot(item) {
  if (item.el?.tagName === 'SELECT') return { select: [...item.el.options].map((o) => o.selected) };
  switch (item.kind) {
    case 'radio':
    case 'checkboxes':
    case 'checkbox':
      return { on: item.members.map((m) => isOn(m.el)) };
    case 'richtext':
      return { text: item.el.innerText };
    case 'listbox':
    case 'dropdown':
    case 'file':
      return { text: '' };
    default:
      return { value: item.el.value };
  }
}

async function fillOne(item, { value, values, date }) {
  const { kind, el } = item;
  if (el.tagName === 'SELECT') return fillSelect(item, value, values);
  if (date && ['text', 'tel', 'date'].includes(kind)) return fillDate(item, date);
  switch (kind) {
    case 'radio': {
      const i = matchOption(
        item.members.map((m) => m.text),
        value,
      );
      if (i === -1) return 'No matching option.';
      const target = item.members[i].el;
      if (!isOn(target)) toggle(target);
      await sleep(item.members[i].el.tagName === 'INPUT' ? 0 : 150);
      return isOn(target) ? '' : 'The page would not take that choice.';
    }
    case 'checkboxes': {
      const want = new Set(values.map((v) => matchOption(item.members.map((m) => m.text), v)).filter((i) => i !== -1));
      for (const [i, m] of item.members.entries()) {
        if (isOn(m.el) !== want.has(i)) {
          toggle(m.el);
          await sleep(m.el.tagName === 'INPUT' ? 0 : 120);
        }
      }
      return item.members.every((m, i) => isOn(m.el) === want.has(i)) ? '' : 'Some boxes would not change.';
    }
    case 'checkbox': {
      const target = item.members[0].el;
      const want = value === 'Yes';
      if (isOn(target) !== want) toggle(target);
      await sleep(target.tagName === 'INPUT' ? 0 : 150);
      return isOn(target) === want ? '' : 'The box would not change.';
    }
    case 'listbox':
    case 'dropdown':
      return pickFromPopup(el, value);
    case 'combobox':
      return fillCombobox(el, value);
    case 'file':
      return attachResume(el);
    case 'richtext':
      return fillRichText(el, value);
    default:
      return fillText(el, value);
  }
}

// Filling focuses page fields, which would pull the cursor out of whatever
// the person is typing in the panel. The panel hooks in here to get it back.
export const focusHooks = { save: null, restore: null };

export async function fillMany(items) {
  const token = focusHooks.save?.();
  // Clicking through dropdowns scrolls the page; put it back where it was.
  const { scrollX, scrollY } = window;
  try {
    return await fillAll(items);
  } finally {
    keepScroll(scrollX, scrollY);
    focusHooks.restore?.(token);
  }
}

async function fillEach(item, it) {
  try {
    const out = await fillOne(item, it);
    const error = typeof out === 'string' ? out : out.error;
    const result = { id: it.id, ok: !error, error };
    if (!error) {
      written.set(it.id, answerKey(currentOf(item)));
      if (out?.shown) result.shown = out.shown;
    }
    return result;
  } catch (err) {
    return { id: it.id, ok: false, error: err?.message || 'Could not fill this field.' };
  }
}

async function fillAll(items) {
  const results = [];
  for (const it of items) {
    const item = entry(it.id);
    if (!item || !item.el.isConnected) {
      results.push({ id: it.id, ok: false, error: 'The field is gone. Rescan the page.' });
      continue;
    }
    if (!snapshots.has(it.id)) snapshots.set(it.id, snapshot(item));
    results.push(await fillEach(item, it));
  }
  // One answer can undo another: choosing a country reloads the city list,
  // a masked field reformats on blur. Look at everything once more and fill
  // again whatever changed after it was filled.
  if (items.length > 1) {
    await sleep(150);
    for (const [i, it] of items.entries()) {
      if (!results[i].ok) continue;
      const item = entry(it.id);
      if (!item?.el.isConnected || answerKey(currentOf(item)) === written.get(it.id)) continue;
      const again = await fillEach(item, it);
      results[i] = again.ok ? again : { ...again, error: `${again.error || 'It changed after another answer went in.'} Check it.` };
    }
  }
  return results;
}

export async function undoMany(ids) {
  const results = [];
  for (const id of ids) {
    const item = entry(id);
    const snap = snapshots.get(id);
    if (!item || !snap) {
      results.push({ id, ok: false });
      continue;
    }
    try {
      if (snap.select) {
        snap.select.forEach((on, i) => (item.el.options[i].selected = on));
        item.el.dispatchEvent(new Event('input', { bubbles: true }));
        item.el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (snap.on) {
        for (const [i, m] of item.members.entries()) {
          if (isOn(m.el) === snap.on[i]) continue;
          if (m.el.tagName === 'INPUT' && m.el.type === 'radio' && !snap.on[i]) {
            m.el.checked = false;
            m.el.dispatchEvent(new Event('change', { bubbles: true }));
          } else toggle(m.el);
        }
      } else if (item.kind === 'file') {
        item.el.files = new DataTransfer().files;
        item.el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (item.kind === 'richtext') {
        item.el.textContent = snap.text;
        item.el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else if (item.kind !== 'listbox' && item.kind !== 'dropdown') {
        typeInto(item.el, snap.value);
      }
      snapshots.delete(id);
      written.delete(id);
      results.push({ id, ok: true });
    } catch {
      results.push({ id, ok: false });
    }
  }
  return results;
}

// ---------------------------------------------------------------- highlights

const COLORS = { fill: '#8b7bff', ask: '#f5b544', draft: '#5cc8ff', sensitive: '#ff7a9a', consent: '#ff7a9a', mine: '#4fd1a5' };
const marked = new Map(); // element -> original inline styles

function markTarget(item) {
  if (item.widget) return item.widget;
  if (item.kind === 'radio' || item.kind === 'checkboxes') return item.container || item.el.parentElement;
  if (item.kind === 'checkbox') return item.el.closest('label') || item.el.parentElement || item.el;
  if (item.kind === 'file') return item.el.labels?.[0] || item.el.parentElement;
  return item.el;
}

export function markMany(marks) {
  for (const [id, status] of Object.entries(marks)) {
    const item = entry(id);
    if (!item) continue;
    const target = markTarget(item);
    if (!target) continue;
    if (!marked.has(target)) {
      marked.set(target, { outline: target.style.outline, outlineOffset: target.style.outlineOffset, borderRadius: target.style.borderRadius });
    }
    const color = COLORS[status];
    if (!color) {
      restore(target);
      continue;
    }
    target.style.outline = `2px solid ${color}`;
    target.style.outlineOffset = '2px';
  }
}

function restore(target) {
  const orig = marked.get(target);
  if (!orig) return;
  target.style.outline = orig.outline;
  target.style.outlineOffset = orig.outlineOffset;
  marked.delete(target);
}

export function clearMarks() {
  for (const target of [...marked.keys()]) restore(target);
}

export function focusField(id) {
  const item = entry(id);
  if (!item) return false;
  const target = markTarget(item) || item.el;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = target.style.boxShadow;
  target.style.transition = 'box-shadow .3s ease';
  target.style.boxShadow = '0 0 0 6px rgba(139, 123, 255, .45)';
  setTimeout(() => {
    target.style.boxShadow = prev;
  }, 1400);
  if (['text', 'email', 'tel', 'url', 'number', 'textarea', 'date', 'month', 'time'].includes(item.kind)) {
    setTimeout(() => item.el.focus({ preventScroll: true }), 400);
  }
  return true;
}

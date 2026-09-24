// Puts answers into the page the way a person would, so React, Angular and
// Google Forms all notice. Every fill is read back; anything that did not
// stick is reported instead of assumed.

import { entry, isOn } from './scan.js';
import { clean, matchOption, norm } from '../shared/text.js';
import { closePopup, controlText, keepScroll, openOptions, optionText, realClick, sleep, visibleOptions, waitFor } from './dom.js';

const snapshots = new Map(); // id -> how the field looked before Fill.ai touched it

// ---------------------------------------------------------------- primitives

function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
}

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
  await sleep(250);
  if (control.getAttribute('role') === 'listbox') return '';
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
  switch (item.kind) {
    case 'radio':
    case 'checkboxes':
    case 'checkbox':
      return { on: item.members.map((m) => isOn(m.el)) };
    case 'select':
      return { value: item.el.value };
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

async function fillOne(item, { value, values }) {
  const { kind, el } = item;
  switch (kind) {
    case 'select': {
      const opts = item.selectOptions;
      if (el.multiple) {
        for (const o of opts) el.options[o.index].selected = values.some((v) => matchOption([o.text], v) === 0);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return '';
      }
      const i = matchOption(
        opts.map((o) => o.text),
        value,
      );
      if (i === -1) return 'No matching option.';
      el.focus({ preventScroll: true });
      setNativeValue(el, opts[i].value);
      el.selectedIndex = opts[i].index;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return el.selectedIndex === opts[i].index ? '' : 'The page would not take that option.';
    }
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
    case 'richtext': {
      el.focus();
      document.execCommand('selectAll', false);
      const ok = document.execCommand('insertText', false, value);
      if (!ok || clean(el.innerText) !== clean(value)) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
      el.blur();
      return '';
    }
    default: {
      typeInto(el, value);
      await sleep(0);
      if (el.value === value) return '';
      // Masked inputs reformat what they get ("98765 43210"); same digits is fine.
      if (el.value && el.value.replace(/\D/g, '') === value.replace(/\D/g, '') && /\d/.test(value)) return '';
      return el.value ? '' : 'The page cleared the value.';
    }
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

async function fillAll(items) {
  const results = [];
  for (const it of items) {
    const item = entry(it.id);
    if (!item || !item.el.isConnected) {
      results.push({ id: it.id, ok: false, error: 'The field is gone. Rescan the page.' });
      continue;
    }
    if (!snapshots.has(it.id)) snapshots.set(it.id, snapshot(item));
    try {
      const error = await fillOne(item, it);
      results.push({ id: it.id, ok: !error, error });
    } catch (err) {
      results.push({ id: it.id, ok: false, error: err?.message || 'Could not fill this field.' });
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
      if (snap.on) {
        for (const [i, m] of item.members.entries()) {
          if (isOn(m.el) === snap.on[i]) continue;
          if (m.el.tagName === 'INPUT' && m.el.type === 'radio' && !snap.on[i]) {
            m.el.checked = false;
            m.el.dispatchEvent(new Event('change', { bubbles: true }));
          } else toggle(m.el);
        }
      } else if (item.kind === 'select') {
        setNativeValue(item.el, snap.value);
        item.el.dispatchEvent(new Event('change', { bubbles: true }));
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
      results.push({ id, ok: true });
    } catch {
      results.push({ id, ok: false });
    }
  }
  return results;
}

// ---------------------------------------------------------------- highlights

const COLORS = { fill: '#8b7bff', ask: '#f5b544', draft: '#5cc8ff', sensitive: '#ff7a9a', consent: '#ff7a9a' };
const marked = new Map(); // element -> original inline styles

function markTarget(item) {
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

// DOM helpers shared by the form reader and the filler.

import { clean } from '../shared/text.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The full pointer sequence. Many custom widgets (react-select among them)
// ignore a bare click or focus and only open on this exact sequence.
//
// The events go to whatever a real pointer would land on: the innermost
// element under the middle of `el`. Google Forms only opens a dropdown when
// the click comes from inside one particular child
// (jsaction="click:cOuCgd(LgbsSe)"); a click on the listbox itself does nothing.
export function realClick(el) {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const target = hitTarget(el, x, y);
  const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
  target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.({ preventScroll: true });
  target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.dispatchEvent(new MouseEvent('click', opts));
}

// Only a descendant of `el` counts: if something else covers it (the Fill.ai
// panel, a sticky header), the events still go to `el` itself.
function hitTarget(el, x, y) {
  const root = el.getRootNode();
  const hit = (root.elementFromPoint ? root.elementFromPoint(x, y) : null) || document.elementFromPoint(x, y);
  return hit && hit !== el && el.contains(hit) ? hit : el;
}

export function isOn(el) {
  if (el.tagName === 'INPUT') return el.checked;
  return el.getAttribute('aria-checked') === 'true';
}

// The element that really has the keyboard, looking inside shadow roots.
export function deepActive() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

export function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
}

// Type into an input one key at a time, the way a keyboard does. Input masks
// (dates, phone numbers) rebuild the value on every key, so setting the whole
// value at once can leave them half-applied ("20/07/2004" becoming "20/07/20").
// Each character goes in through execCommand, which the page sees as real
// typing; a page that handles the key itself (and cancels it) is left to.
export async function typeKeys(el, value) {
  el.focus({ preventScroll: true });
  if (deepActive() !== el) return false;
  el.select?.();
  if (!document.execCommand('delete', false) && el.value) {
    setNativeValue(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
  }
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    const key = { key: ch, bubbles: true, cancelable: true, composed: true };
    const down = el.dispatchEvent(new KeyboardEvent('keydown', { ...key, keyCode: code, which: code }));
    const press = down && el.dispatchEvent(new KeyboardEvent('keypress', { ...key, keyCode: code, charCode: code, which: code }));
    if (press && deepActive() === el) document.execCommand('insertText', false, ch);
    el.dispatchEvent(new KeyboardEvent('keyup', { ...key, keyCode: code, which: code }));
    await sleep(0);
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  el.blur();
  return true;
}

// Put the page back where the person left it. Widgets such as react-select
// animate the page towards their menu and keep going after we are done, so
// hold the position for a moment, and let go the instant the person scrolls.
let holding = null;
export function keepScroll(x, y, ms = 700) {
  holding?.();
  const pin = () => window.scrollTo({ left: x, top: y, behavior: 'instant' });
  pin();
  const stop = (e) => {
    if (e && !e.isTrusted) return; // our own synthetic clicks and keys don't count
    removeEventListener('scroll', onScroll, true);
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(t, stop, true);
    clearTimeout(timer);
    holding = null;
  };
  const onScroll = () => {
    if (window.scrollX !== x || window.scrollY !== y) pin();
  };
  addEventListener('scroll', onScroll, true);
  for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(t, stop, { capture: true, passive: true });
  const timer = setTimeout(() => stop(), ms);
  holding = stop;
}

export async function waitFor(fn, timeout = 1500, step = 40) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v && (!Array.isArray(v) || v.length)) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

export function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true);
}

export function optionText(el) {
  return clean(el.getAttribute('data-value') || el.getAttribute('aria-label') || el.innerText || el.textContent);
}

// Select2 4.0 (still common on job sites) gives its results no role=option.
const OPTION = '[role="option"], .select2-results__option';

// Options currently offered for this control: the popup it points at
// (aria-controls / aria-owns) when there is one, otherwise any visible option
// that was not already on screen before it opened.
export function openOptions(control, before = new Set()) {
  for (const attr of ['aria-controls', 'aria-owns']) {
    for (const id of (control.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
      const node = control.getRootNode().getElementById?.(id) || document.getElementById(id);
      const opts = node ? [...node.querySelectorAll(OPTION)].filter(visible) : [];
      if (opts.length) return opts;
    }
  }
  return [...document.querySelectorAll(OPTION)].filter((o) => !before.has(o) && visible(o));
}

export function visibleOptions() {
  return new Set([...document.querySelectorAll(OPTION)].filter(visible));
}

export function pressEscape(el) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, composed: true }));
}

// Close a popup we opened: blur is what react-select listens for, Escape is
// what most other widgets do.
export async function closePopup(control, before) {
  control.blur?.();
  await sleep(30);
  if (openOptions(control, before).length) pressEscape(control);
  await sleep(30);
  if (openOptions(control, before).length) pressEscape(document.activeElement || document.body);
}

// The visible text of a custom control, used to check a choice stuck.
export function controlText(el) {
  const box = el.closest('[class*="control"], [class*="Control"]') || el.parentElement?.parentElement || el;
  return clean(box.textContent);
}

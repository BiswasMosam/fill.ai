// DOM helpers shared by the form reader and the filler.

import { clean } from '../shared/text.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The full pointer sequence. Many custom widgets (react-select among them)
// ignore a bare click or focus and only open on this exact sequence.
export function realClick(el) {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
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

// Options currently offered for this control: the popup it points at
// (aria-controls / aria-owns) when there is one, otherwise any visible option
// that was not already on screen before it opened.
export function openOptions(control, before = new Set()) {
  for (const attr of ['aria-controls', 'aria-owns']) {
    for (const id of (control.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
      const node = control.getRootNode().getElementById?.(id) || document.getElementById(id);
      const opts = node ? [...node.querySelectorAll('[role="option"]')].filter(visible) : [];
      if (opts.length) return opts;
    }
  }
  return [...document.querySelectorAll('[role="option"]')].filter((o) => !before.has(o) && visible(o));
}

export function visibleOptions() {
  return new Set([...document.querySelectorAll('[role="option"]')].filter(visible));
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

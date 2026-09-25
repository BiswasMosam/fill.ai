// Reads the form on this page (this frame only) into plain field descriptions.
//
// Handles native inputs, ARIA widgets (Google Forms is built from role=radio,
// role=checkbox and role=listbox divs), open shadow roots, and custom
// dropdowns. Invisible fields are ignored on purpose: a hidden "phone" input
// is the classic trick for harvesting autofill data.

import { clean } from '../shared/text.js';
import { detectFormat, formatName } from '../shared/dates.js';
import { closePopup, controlText, isOn, keepScroll, openOptions, optionText, realClick, visibleOptions, waitFor } from './dom.js';

export { isOn };

const CONTROLS = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="listbox"]',
  '[role="combobox"]',
  'button[aria-haspopup="listbox"]',
].join(',');

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search', 'range', 'color']);
const TEXT_TYPES = new Set(['email', 'tel', 'url', 'number', 'date', 'month', 'time', 'datetime-local', 'week']);
const PLACEHOLDER_OPTION = /^(select|choose|pick|please select|please choose|--|—|-)\b|^\s*$|^(select|choose)\s*(one|an option|\.\.\.)?$/i;
const GENERIC_LABEL = /^(your answer|select|choose|choose an option|select an option|select\.\.\.|enter|type here|answer)$/i;
const ACTION_LABEL = /^(attach|upload|browse|choose|select|add)( an?| your)?( files?| documents?| resume)?\.?$/i;

export const PANEL_HOST_ID = 'fillai-root';

// Stable ids across rescans, so the panel can keep talking about a field
// after the page re-renders around it.
const ids = new WeakMap();
let counter = 0;
const registry = new Map();

function idFor(el) {
  let id = ids.get(el);
  if (!id) {
    counter += 1;
    id = `f${counter}`;
    ids.set(el, id);
  }
  return id;
}

export function entry(id) {
  return registry.get(id);
}

// What each field showed right after Fill.ai filled it. A value that still
// matches came from Fill.ai, not from the person.
export const written = new Map();

export function answerKey(value) {
  return JSON.stringify(Array.isArray(value) ? [...value].sort() : value ?? '');
}

export function isKnown(el) {
  return ids.has(el);
}

function roots() {
  const out = [document];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot && el.id !== PANEL_HOST_ID) {
        out.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    }
  };
  walk(document);
  return out;
}

function queryAll(selector) {
  return roots().flatMap((root) => [...root.querySelectorAll(selector)]);
}

// ---------------------------------------------------------------- visibility

function rendered(el) {
  if (!el || !el.isConnected) return false;
  if (typeof el.checkVisibility === 'function') {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
  } else {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.right + window.scrollX < 0 || r.bottom + window.scrollY < 0) return false; // parked off-screen
  return true;
}

// Native radios, checkboxes and file inputs are often visually hidden behind
// a styled label. Judge those by what the person can actually see.
function visibleControl(el) {
  if (rendered(el)) return true;
  const tag = el.tagName;
  const type = (el.getAttribute('type') || '').toLowerCase();
  // Search-as-you-type comboboxes (react-select and friends) shrink their real
  // input to a couple of pixels inside a visible box.
  if (tag === 'INPUT' && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list')) {
    const box = el.parentElement?.parentElement;
    return !!box && rendered(box) && el.checkVisibility?.({ opacityProperty: false, visibilityProperty: true }) !== false;
  }
  if (tag === 'INPUT' && ['radio', 'checkbox', 'file'].includes(type)) {
    for (const label of el.labels || []) if (rendered(label)) return true;
    const wrapper = el.closest('label');
    if (wrapper && rendered(wrapper)) return true;
    if (type === 'file') {
      let node = el.parentElement;
      for (let i = 0; i < 3 && node; i += 1, node = node.parentElement) {
        if (rendered(node) && node.querySelector('button, [role="button"], label')) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- text

function textFrom(el) {
  if (!el) return '';
  return clean(el.innerText || el.textContent || '');
}

function byIds(el, attr) {
  const list = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
  const root = el.getRootNode();
  return list
    .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
    .filter(Boolean)
    .map((node) => visibleText(node) || clean(node.textContent))
    .filter(Boolean)
    .join(' ');
}

function hasControl(el) {
  return el.matches?.(CONTROLS) || !!el.querySelector?.(CONTROLS);
}

// The nearest text that reads like this control's question: walk up a few
// levels and look at earlier siblings, stopping as soon as we reach another
// question's control.
function nearbyText(start) {
  let node = start;
  for (let depth = 0; depth < 6 && node && node !== document.body; depth += 1) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (hasControl(sib)) return '';
      const t = textFrom(sib);
      if (t && ACTION_LABEL.test(t)) {
        sib = sib.previousElementSibling;
        continue;
      }
      if (t) return t.length <= 300 ? t : '';
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

function tidyLabel(text) {
  return clean(text)
    .replace(/[✱＊∗]/g, '*') // ✱ ＊ ∗ required markers
    .replace(/\s*\*+\s*$/, '')
    .replace(/\s*\((required|optional)\)\s*$/i, '')
    .replace(/\s*required question\s*$/i, '')
    .replace(/\s*\*\s*/g, ' ')
    .trim()
    .slice(0, 300);
}

function ownLabel(el) {
  const byLabelledby = byIds(el, 'aria-labelledby');
  if (byLabelledby) return byLabelledby;
  // Several labels can point at one input ("Resume/CV" plus an "Attach file"
  // button). The button text is not the question.
  const fromLabels = [...(el.labels || [])]
    .map(labelText)
    .filter((t) => t && !ACTION_LABEL.test(t))
    .join(' ');
  if (fromLabels) return fromLabels;
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  return '';
}

// Only the text a person can see. Labels often wrap their control plus hidden
// status messages ("Couldn't read resume", "Loading"); those are not the
// question.
function visibleText(root) {
  let out = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest('input, select, textarea, option, [role="listbox"], [role="option"]')) continue;
    if (p.checkVisibility && !p.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    out += ` ${n.textContent}`;
  }
  return clean(out);
}

// A <label> can wrap its control and other text; read it without the value
// of anything inside it, and without what is hidden.
function labelText(label) {
  return visibleText(label);
}

function humanize(name) {
  return clean(String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-[\].]+/g, ' '));
}

// A fieldset legend names a question only when the fieldset holds nothing
// but that question's controls. One big fieldset around a whole form must
// not rename every field in it.
function legendFor(node, own) {
  const fieldset = node.closest('fieldset');
  const legend = fieldset?.querySelector(':scope > legend');
  if (!legend) return '';
  const controls = [...fieldset.querySelectorAll(CONTROLS)].filter((c) => kindOf(c));
  return controls.every((c) => own.includes(c)) ? textFrom(legend) : '';
}

function labelFor(el, container, own = [el]) {
  const anchor = container || el;
  // For a group, the first option's own label ("Yes", "Python") is an
  // answer, not the question. Only the group's own naming counts.
  let label = ownLabel(anchor);
  if (!label || GENERIC_LABEL.test(label)) {
    const group = anchor.parentElement?.closest('[role="group"][aria-labelledby], [role="group"][aria-label]');
    const near = legendFor(anchor, own) || (group && ownLabel(group)) || nearbyText(anchor);
    if (near) label = label && !GENERIC_LABEL.test(label) ? `${near} ${label}` : near;
  }
  if (!label) label = el.getAttribute('placeholder') || el.getAttribute('title') || humanize(el.getAttribute('name') || el.id);
  return tidyLabel(label);
}

function isRequired(el, label) {
  return !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label || ''));
}

// ---------------------------------------------------------------- sections

// Section headings only: real h1-h4 and ARIA headings of level 1-2. Google
// Forms marks every question title as an aria-level 3 heading, and those
// must not become the "section" of the next question.
function headingsIn() {
  return queryAll('h1, h2, h3, h4, [role="heading"]').filter((h) => {
    if (h.getAttribute('role') === 'heading' && Number(h.getAttribute('aria-level') || 2) > 2) return false;
    return rendered(h) && !hasControl(h);
  });
}

function sectionFor(el, headings, label) {
  // A legend only names the fieldset it belongs to.
  const legend = el.closest?.('fieldset')?.querySelector(':scope > legend');
  const legendText = legend ? textFrom(legend) : '';
  if (legendText && tidyLabel(legendText) !== label && legendText.length < 120) return legendText;
  let best = '';
  for (const h of headings) {
    const pos = h.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_DISCONNECTED) continue;
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING && !(pos & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
      const t = textFrom(h);
      if (t && t.length < 120 && tidyLabel(t) !== label) best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------- options

function inlineText(input) {
  const labels = [...(input.labels || [])].map(labelText).filter(Boolean);
  if (labels.length) return labels.join(' ');
  const aria = input.getAttribute('aria-label');
  if (aria) return clean(aria);
  let t = '';
  for (let n = input.nextSibling; n && t.length < 120; n = n.nextSibling) {
    if (n.nodeType === Node.ELEMENT_NODE && hasControl(n)) break;
    t += ` ${n.textContent || ''}`;
  }
  return clean(t) || clean(input.value);
}

function ariaOptionText(el) {
  // Google Forms' "Other:" choice carries this internal value.
  if (el.getAttribute('data-value') === '__other_option__') return 'Other';
  return clean(el.getAttribute('aria-label') || el.getAttribute('data-value') || el.getAttribute('data-answer-value') || textFrom(el) || textFrom(el.closest('label')));
}

function selectOptions(select) {
  const out = [];
  [...select.options].forEach((opt, index) => {
    const text = clean(opt.textContent);
    if (opt.disabled && index === 0) return;
    if (!opt.value && PLACEHOLDER_OPTION.test(text)) return;
    if (!text && !opt.value) return;
    out.push({ text: text || opt.value, value: opt.value, index });
  });
  return out;
}

function listboxOptions(listbox) {
  let opts = [...listbox.querySelectorAll('[role="option"]')];
  if (!opts.length) {
    const owned = byIdsElements(listbox, 'aria-owns');
    opts = owned.flatMap((n) => [...n.querySelectorAll('[role="option"]')]);
  }
  const seen = new Set();
  const out = [];
  for (const opt of opts) {
    const value = opt.getAttribute('data-value');
    const text = clean(value ?? ariaOptionText(opt));
    if (!text || (value === '' && PLACEHOLDER_OPTION.test(textFrom(opt))) || PLACEHOLDER_OPTION.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text });
  }
  return out;
}

function byIdsElements(el, attr) {
  const root = el.getRootNode();
  return (el.getAttribute(attr) || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => (root.getElementById ? root.getElementById(id) : document.getElementById(id)))
    .filter(Boolean);
}

// ---------------------------------------------------------------- kinds

function kindOf(el) {
  const tag = el.tagName;
  const role = el.getAttribute('role');
  if (tag === 'SELECT') return 'select';
  if (tag === 'TEXTAREA') return 'textarea';
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (SKIP_TYPES.has(type)) return null;
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'file') return 'file';
    if (role === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' || el.closest('[role="combobox"]')) return 'combobox';
    if (TEXT_TYPES.has(type)) return type === 'datetime-local' || type === 'week' ? 'text' : type;
    return 'text';
  }
  if (role === 'radio') return 'aria-radio';
  if (role === 'checkbox' || role === 'switch') return 'aria-checkbox';
  if (role === 'listbox') return 'listbox';
  if (role === 'combobox' || (tag === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox')) {
    return el.querySelector('input, textarea') ? null : 'dropdown';
  }
  // Only something the person could type into. A role=textbox that is not
  // editable is a display: Select2 shows the chosen city in one, and typing
  // "at" it once sent the text into the previous field instead.
  if (el.isContentEditable) {
    if (el.parentElement?.closest('[contenteditable="true"], [contenteditable=""]')) return null;
    return 'richtext';
  }
  return null;
}

// ---------------------------------------------------------------- enhanced selects

// Select2, Chosen, Tom Select, selectize and friends hide the real <select>
// and draw their own box beside it. The hidden select is still what the page
// submits, so Fill.ai treats it as the question and the drawn box only as the
// place it lives on screen. Everything inside the box is the widget's own
// machinery, not more questions.
const WIDGET_CLASS = /(^|\s)(select2-container|select2|chosen-container|selectize-control|ts-wrapper|choices|bootstrap-select)(\s|$)/;
const WIDGET_POPUP = '.select2-dropdown, .select2-container--open, .chosen-drop, .ts-dropdown, .selectize-dropdown';

function widgetFor(select) {
  if (select.tagName !== 'SELECT' || rendered(select)) return null;
  const next = select.nextElementSibling;
  const candidates = [next, select.parentElement, select.closest('.choices, .bootstrap-select')];
  for (const c of candidates) {
    if (!c || c.id === PANEL_HOST_ID) continue;
    const cls = typeof c.className === 'string' ? c.className : '';
    const looksLike = WIDGET_CLASS.test(cls) || (c === next && !!c.querySelector('[role="combobox"], [aria-haspopup]'));
    if (looksLike && rendered(c)) return c;
  }
  return null;
}

function findWidgets() {
  const map = new Map();
  for (const select of queryAll('select')) {
    const w = widgetFor(select);
    if (w) map.set(select, w);
  }
  return map;
}

function insideWidget(el, widgets) {
  if (widgets.has(el)) return false;
  if (el.closest(WIDGET_POPUP)) return true;
  for (const w of widgets.values()) if (w.contains(el)) return true;
  return false;
}

// A listbox that is only the popup of some combobox is not its own question.
function isPopupList(listbox) {
  if (!listbox.id) return false;
  return !!document.querySelector(`[aria-controls~="${CSS.escape(listbox.id)}"], [aria-owns~="${CSS.escape(listbox.id)}"]`);
}

const CHOICE_SELECTOR = {
  radio: '[role="radio"], input[type="radio"]',
  checkbox: '[role="checkbox"], [role="switch"], input[type="checkbox"]',
};

// Which question a radio or checkbox belongs to. Native radios are grouped by
// name (that is what a radio group is); ARIA ones by their radiogroup; loose
// checkboxes by the nearest ancestor that holds more than one of them.
function groupKey(el, role) {
  if (el.tagName === 'INPUT' && el.name) {
    const scope = el.form || el.getRootNode();
    const same = [...scope.querySelectorAll(`input[type="${role}"]`)].filter((c) => c.name === el.name);
    if (role === 'radio' || same.length > 1) return `${role}:${el.name}:${el.form ? [...document.forms].indexOf(el.form) : 'x'}`;
  }
  const explicit = el.closest(role === 'radio' ? '[role="radiogroup"]' : '[role="group"], [role="list"]');
  if (explicit && explicit.querySelectorAll(CHOICE_SELECTOR[role]).length > 1) return explicit;
  let node = el.parentElement;
  for (let i = 0; i < 5 && node; i += 1, node = node.parentElement) {
    if (node.tagName === 'FORM' || node === document.body) break;
    if (node.querySelectorAll(CHOICE_SELECTOR[role]).length > 1) return node;
  }
  return el;
}

function commonAncestor(els) {
  if (els.length === 1) return els[0].parentElement;
  let node = els[0].parentElement;
  while (node && !els.every((e) => node.contains(e))) node = node.parentElement;
  return node;
}

function containerFor(members) {
  const els = members.map((m) => m.el);
  const explicit = els[0].closest('[role="radiogroup"], [role="group"], [role="list"]');
  if (explicit && els.every((e) => explicit.contains(e))) return explicit;
  return commonAncestor(els);
}

// ---------------------------------------------------------------- values

// The chosen options of a native select, placeholders left out.
function chosenTexts(select) {
  return [...select.options].filter((o, i) => o.selected && !(i === 0 && o.disabled) && !(!o.value && PLACEHOLDER_OPTION.test(clean(o.textContent)))).map((o) => clean(o.textContent) || o.value);
}

export function currentOf(item) {
  const { kind, el, members } = item;
  if (el?.tagName === 'SELECT') {
    const chosen = chosenTexts(el);
    return item.multiple ? chosen : chosen[0] || '';
  }
  switch (kind) {
    case 'radio':
      return members.find((m) => isOn(m.el))?.text || '';
    case 'checkboxes':
      return members.filter((m) => isOn(m.el)).map((m) => m.text);
    case 'checkbox':
      return isOn(el) ? 'Yes' : '';
    case 'listbox': {
      const sel = el.querySelector('[role="option"][aria-selected="true"]');
      const v = sel && clean(sel.getAttribute('data-value') ?? ariaOptionText(sel));
      return v && !PLACEHOLDER_OPTION.test(v) ? v : '';
    }
    case 'dropdown': {
      const t = textFrom(el);
      return t && !PLACEHOLDER_OPTION.test(t) && !GENERIC_LABEL.test(t) ? t : '';
    }
    case 'file':
      return el.files && el.files.length ? el.files[0].name : '';
    case 'richtext':
      return textFrom(el);
    case 'combobox': {
      // react-select and friends show the choice beside an empty search box.
      if (el.value) return el.value;
      const box = el.closest('[class*="control"], [class*="Control"]');
      const t = box ? controlText(el) : '';
      return t && t.length < 120 && !PLACEHOLDER_OPTION.test(t) && !GENERIC_LABEL.test(t) && t !== item.label ? t : '';
    }
    default:
      return el.value || '';
  }
}

function hasValue(v) {
  return Array.isArray(v) ? v.length > 0 : !!String(v ?? '').trim();
}

// Was this answer put here by the person? With the touch tracker loaded
// (every page opened after Fill.ai was installed) that is exactly the
// fields they changed by hand. Without it, anything that differs from how
// the page first arrived counts, so nothing typed gets overwritten.
function mineState(item) {
  if (!hasValue(item.current)) return null;
  if (written.has(item.id) && written.get(item.id) === answerKey(item.current)) return null;
  const tracker = window.__fillaiTouch;
  if (tracker) {
    const els = [item.el, item.container, ...(item.members || []).map((m) => m.el)].filter(Boolean);
    return els.some((e) => tracker.has(e)) ? 'typed' : null;
  }
  if (item.el?.tagName === 'SELECT') return pageDefault(item.el) ? null : 'kept';
  if (item.members?.some((m) => m.el.tagName === 'INPUT')) return item.members.some((m) => m.el.checked !== m.el.defaultChecked) ? 'kept' : null;
  return 'kept';
}

function pageDefault(select) {
  const opts = [...select.options];
  if (select.multiple) return opts.every((o) => o.selected === o.defaultSelected);
  const defaults = opts.filter((o) => o.defaultSelected);
  return defaults.length ? defaults.at(-1).selected : select.selectedIndex <= 0;
}

// ---------------------------------------------------------------- scan

const seen = new WeakSet(); // every control a scan has already reported

function usable(el, widgets) {
  if (el.closest(`#${PANEL_HOST_ID}`)) return null;
  const raw = kindOf(el);
  if (!raw) return null;
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly || el.getAttribute('aria-readonly') === 'true') return null;
  if (raw === 'listbox' && isPopupList(el)) return null;
  if (insideWidget(el, widgets)) return null;
  if (!visibleControl(el) && !widgets.has(el)) return null;
  return raw;
}

// How many questions have appeared since the last scan (multi-page forms).
export function countNew() {
  const keys = new Set();
  const widgets = findWidgets();
  for (const el of queryAll(CONTROLS)) {
    if (seen.has(el)) continue;
    const raw = usable(el, widgets);
    if (!raw) continue;
    if (raw === 'radio' || raw === 'aria-radio') keys.add(groupKey(el, 'radio'));
    else if (raw === 'checkbox' || raw === 'aria-checkbox') keys.add(groupKey(el, 'checkbox'));
    else keys.add(el);
  }
  return keys.size;
}

export async function scanPage() {
  const headings = headingsIn();
  const items = [];
  const groups = new Map(); // container or name -> item
  const widgets = findWidgets();

  for (const el of queryAll(CONTROLS)) {
    const raw = usable(el, widgets);
    if (!raw) continue;
    seen.add(el);

    if (raw === 'radio' || raw === 'aria-radio' || raw === 'checkbox' || raw === 'aria-checkbox') {
      const role = raw.includes('radio') ? 'radio' : 'checkbox';
      const key = groupKey(el, role);
      const text = el.tagName === 'INPUT' ? inlineText(el) : ariaOptionText(el);
      let group = groups.get(key);
      if (!group) {
        group = { role, members: [], first: el };
        groups.set(key, group);
        items.push({ group });
      }
      group.members.push({ el, text });
      continue;
    }
    items.push({ el, raw, widget: widgets.get(el) });
  }

  registry.clear();
  const fields = [];
  for (const it of items) {
    const item = it.group ? fromGroup(it.group) : fromSingle(it.el, it.raw, it.widget);
    if (!item) continue;
    item.label = item.label || 'Unlabelled field';
    item.section = sectionFor(item.anchor, headings, item.label);
    item.current = currentOf(item);
    item.mine = mineState(item);
    registry.set(item.id, item);
  }
  await probeAll([...registry.values()]);
  for (const item of registry.values()) fields.push(describe(item));
  return fields;
}

// Custom dropdowns only render their options while open. Open each one for a
// moment to read them, so Claude chooses from the real list and the panel can
// offer them as buttons. Long lists (country pickers, school search) stay free
// text: the filler narrows them by typing.
const MAX_OPTIONS = 60;

async function probeAll(items) {
  const targets = items.filter((it) => (it.kind === 'combobox' || it.kind === 'dropdown') && !it.options && !it.widget && !it.mine);
  if (!targets.length) return;
  const { scrollX, scrollY } = window;
  const focused = document.activeElement;
  for (const item of targets) {
    try {
      item.options = await probeOptions(item.el);
    } catch {
      item.options = undefined;
    }
  }
  keepScroll(scrollX, scrollY);
  if (focused && focused !== document.body && focused.isConnected) focused.focus?.({ preventScroll: true });
}

async function probeOptions(el) {
  const before = visibleOptions();
  realClick(el);
  const opts = await waitFor(() => openOptions(el, before), 500);
  const texts = [...new Set((opts || []).map(optionText).filter((t) => t && !PLACEHOLDER_OPTION.test(t)))];
  await closePopup(el, before);
  return texts.length && texts.length <= MAX_OPTIONS ? texts : undefined;
}

function fromGroup(group) {
  const { role, members, first } = group;
  const own = members.map((m) => m.el);
  if (role === 'checkbox' && members.length === 1) {
    const el = members[0].el;
    const text = members[0].text;
    const aria = ownLabel(el);
    const question = aria && aria !== text ? aria : legendFor(el, own) || nearbyText(el.closest('label') || el);
    // "Willing to relocate? [x] Yes" needs both parts; a long consent sentence
    // already says everything on its own.
    const label = tidyLabel(question && question !== text && text.length < 60 ? `${question}: ${text}` : text || question || labelFor(el));
    return { id: idFor(el), kind: 'checkbox', el, anchor: el, members, label, options: ['Yes', 'No'], required: isRequired(el, label) };
  }
  const container = containerFor(members);
  const label = labelFor(first, container || undefined, own);
  const kind = role === 'radio' ? 'radio' : 'checkboxes';
  return {
    id: idFor(first),
    kind,
    el: first,
    container,
    anchor: container || first,
    members,
    label,
    options: members.map((m) => m.text),
    multiple: kind === 'checkboxes',
    required: members.some((m) => isRequired(m.el)) || isRequired(container || first, label),
  };
}

function fromSingle(el, raw, widget) {
  const label = labelFor(el);
  const base = { id: idFor(el), el, anchor: widget || el, widget, label, required: isRequired(el, label) };
  if (raw === 'select') {
    const options = selectOptions(el);
    // A Select2 box that loads its list as you type (or once another answer
    // is chosen) has nothing to offer yet: the answer is typed, then picked.
    if (widget && options.length < 2) return { ...base, kind: 'combobox', multiple: el.multiple };
    return { ...base, kind: 'select', selectOptions: options, options: options.map((o) => o.text), multiple: el.multiple };
  }
  if (raw === 'listbox') {
    const options = listboxOptions(el);
    return { ...base, kind: 'listbox', options: options.map((o) => o.text) };
  }
  return { ...base, kind: raw };
}

// The public description of a field, as sent to the background.
function describe(item) {
  const el = item.el;
  const kind = item.kind === 'listbox' ? 'select' : item.kind;
  const field = { id: item.id, kind, label: item.label };
  const description = el ? byIds(el, 'aria-describedby') : '';
  if (description && description !== item.label) field.description = description.slice(0, 300);
  const placeholder = el?.getAttribute?.('placeholder');
  if (placeholder && placeholder !== item.label) field.placeholder = clean(placeholder);
  if (item.section) field.section = item.section;
  if (item.options) field.options = item.options;
  if (item.multiple) field.multiple = true;
  if (item.required) field.required = true;
  if (item.current && (!Array.isArray(item.current) || item.current.length)) field.current = item.current;
  if (item.mine) field.mine = item.mine;
  const format = {};
  if (el?.maxLength > 0 && el.maxLength < 100000) format.maxLength = el.maxLength;
  if (el?.getAttribute?.('pattern')) format.pattern = el.getAttribute('pattern');
  if (el?.getAttribute?.('min')) format.min = el.getAttribute('min');
  if (el?.getAttribute?.('max')) format.max = el.getAttribute('max');
  if (item.kind === 'file' && el.accept) format.accept = el.accept;
  const date = dateHint(item, field);
  if (date) format.date = date;
  if (Object.keys(format).length) field.format = format;
  const name = el?.getAttribute?.('name');
  if (name) field.name = name;
  const autocomplete = el?.getAttribute?.('autocomplete');
  if (autocomplete && autocomplete !== 'off' && autocomplete !== 'on') field.autocomplete = autocomplete;
  return field;
}

// A date format the field states anywhere: placeholder, input mask
// attributes, hint text or the label ("Date of birth (DD/MM/YYYY)").
const MASK_ATTRS = ['data-mask', 'data-inputmask', 'data-inputmask-inputformat', 'data-date-format', 'data-format', 'data-dateformat'];

function dateHint(item, field) {
  const el = item.el;
  if (!el || !['text', 'tel', 'combobox'].includes(item.kind)) return '';
  const attrs = MASK_ATTRS.map((a) => el.getAttribute(a)).filter(Boolean);
  const fmt = detectFormat(field.placeholder, ...attrs, field.label, field.description);
  item.dateFormat = fmt;
  return formatName(fmt);
}

// What the model needs to know about the page itself (top frame only).
export function pageContext() {
  const headings = [...document.querySelectorAll('h1, h2')].map(textFrom).filter(Boolean).slice(0, 8);
  const text = clean(document.body ? document.body.innerText : '').slice(0, 4000);
  return { title: clean(document.title), url: location.origin + location.pathname, headings, text };
}

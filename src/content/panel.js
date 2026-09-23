// The floating fill.ai panel. Lives in the top frame inside a shadow root so
// the page's CSS can't touch it (and, outside tests, the page's scripts
// can't read or click it either).

import { PANEL_CSS } from './panel-css.js';
import { PANEL_HOST_ID, countNew } from './scan.js';
import { focusHooks } from './fill.js';
import { escapeHtml as h } from '../shared/text.js';

// Each copy needs its own gradient id: Chrome won't paint a gradient whose
// <defs> sit inside a hidden element, so a shared id blanks the pill's logo
// whenever the panel (holding the first copy) is hidden.
let logoCount = 0;
export function logo(size) {
  logoCount += 1;
  const id = `fa-g${logoCount}`;
  const style = size ? ` style="width:${size}px;height:${size}px"` : '';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${style}><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><rect width="24" height="24" rx="7" fill="url(#${id})"/><path d="M14.6 6.4h-1.9a2.6 2.6 0 0 0-2.6 2.6v9.2M7.9 11.6h5.2" stroke="#fff" stroke-width="2.1" stroke-linecap="round" fill="none"/><circle cx="16.6" cy="16.4" r="1.7" fill="#fff"/></svg>`;
}

const STEPS = [
  ['reading', 'Reading the form'],
  ['thinking', 'Matching it with your profile'],
  ['filling', 'Filling in what fill.ai knows'],
];

// Kinds that take typed text even when they carry options (none do today,
// but a combobox or dropdown with known options is shown as a choice).
const TEXTISH = new Set(['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'time', 'textarea', 'richtext']);

export class Panel {
  constructor() {
    this.state = { view: 'idle', fields: [], progress: null, error: null, cost: null, dropped: 0, newFields: 0 };
    this.port = null;
    this.open = false;
    this.minimized = false;
    this.pos = null;
    this.observer = null;
    this.build();
  }

  // ------------------------------------------------------------ shell

  build() {
    this.host = document.createElement('div');
    this.host.id = PANEL_HOST_ID;
    this.host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    this.root = this.host.attachShadow({ mode: __TEST__ ? 'open' : 'closed' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    this.wrap = document.createElement('div');
    this.wrap.className = 'wrap';
    this.wrap.innerHTML = `
      <section class="panel" role="dialog" aria-label="fill.ai" hidden>
        <header class="bar">
          <div class="brand">${logo()}<span>fill.ai</span></div>
          <div class="site">${h(location.hostname.replace(/^www\./, ''))}</div>
          <button class="icon" data-act="min" title="Shrink" aria-label="Shrink">&#8211;</button>
          <button class="icon" data-act="close" title="Close" aria-label="Close">&#215;</button>
        </header>
        <div class="body"></div>
        <footer class="foot"><span class="grow meta">Never submits. You check, then you submit.</span><button class="link" data-act="rescan">Rescan</button></footer>
      </section>
      <button class="pill" data-act="restore" aria-label="Open fill.ai" hidden>${logo()}<span class="badge" hidden></span></button>`;
    this.root.append(style, this.wrap);
    this.panel = this.wrap.querySelector('.panel');
    this.body = this.wrap.querySelector('.body');
    this.pill = this.wrap.querySelector('.pill');
    this.meta = this.wrap.querySelector('.meta');

    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    // Remember where the cursor was (which card, which input), not the element
    // itself: another answer can re-render the panel while a fill is running.
    focusHooks.save = () => this.capture().focus;
    focusHooks.restore = (spot) => this.refocus(spot);
    this.dragify(this.wrap.querySelector('.bar'), this.panel);
    this.dragify(this.pill, this.pill);
    window.addEventListener('resize', () => this.place());
  }

  mount() {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host);
  }

  async show() {
    this.mount();
    if (!this.pos) {
      try {
        const { panelPos } = await chrome.storage.local.get('panelPos');
        this.pos = panelPos || null;
      } catch {
        this.pos = null;
      }
    }
    this.open = true;
    this.minimized = false;
    this.panel.hidden = false;
    this.pill.hidden = true;
    this.place();
    if (this.state.view === 'idle' || this.state.view === 'error') this.start();
  }

  hide() {
    this.open = false;
    this.panel.hidden = true;
    this.pill.hidden = true;
    this.stopWatching();
    this.send({ type: 'clear-marks' });
    this.state = { ...this.state, view: 'idle', fields: [], newFields: 0 };
    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
  }

  toggle() {
    if (this.open && !this.minimized) this.hide();
    else this.show();
  }

  minimize() {
    this.minimized = true;
    this.panel.hidden = true;
    this.pill.hidden = false;
    this.place();
  }

  // Keep the panel where the person put it, but always on screen.
  // `pos` is always the panel's top-left. The pill sits at the panel's
  // top-right corner, so shrinking and growing happen in the same place.
  panelWidth() {
    return Math.min(372, window.innerWidth - 16);
  }

  pillOffset() {
    return this.minimized ? this.panelWidth() - 48 : 0;
  }

  place() {
    const pw = this.panelWidth();
    let x = this.pos?.x ?? window.innerWidth - pw - 20;
    let y = this.pos?.y ?? 20;
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - 88));
    const el = this.minimized ? this.pill : this.panel;
    el.style.left = `${x + this.pillOffset()}px`;
    el.style.top = `${y}px`;
  }

  dragify(handle, target) {
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target.closest('button') && e.target.closest('button') !== handle)) return;
      const r = target.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
      drag.moved = true;
      this.pos = { x: e.clientX - drag.dx - this.pillOffset(), y: e.clientY - drag.dy };
      this.place();
    });
    const end = (e) => {
      if (!drag) return;
      if (drag.moved) {
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        chrome.storage.local.set({ panelPos: this.pos }).catch(() => {});
      }
      drag = null;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------ talking to the background

  connect() {
    if (this.port) return this.port;
    this.port = chrome.runtime.connect({ name: 'fillai-panel' });
    this.port.onMessage.addListener((msg) => this.onMessage(msg));
    this.port.onDisconnect.addListener(() => {
      this.port = null;
      if (this.state.view === 'working') this.fail('fill.ai was interrupted. Try again.');
    });
    return this.port;
  }

  send(msg) {
    try {
      this.connect().postMessage(msg);
    } catch {
      this.port = null;
      try {
        this.connect().postMessage(msg);
      } catch {
        this.fail('fill.ai was updated or restarted. Reload this page and try again.');
      }
    }
  }

  start() {
    this.stopWatching();
    this.state = { ...this.state, view: 'working', progress: { stage: 'reading' }, error: null, newFields: 0 };
    this.render();
    this.send({ type: 'analyze' });
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'needs-setup':
        this.state = { ...this.state, view: 'setup', missing: msg.missing };
        break;
      case 'progress':
        this.state = { ...this.state, view: 'working', progress: msg };
        break;
      case 'result':
        this.state = { ...this.state, view: msg.fields.length ? 'results' : 'empty', fields: msg.fields, cost: msg.cost, dropped: msg.dropped || 0 };
        this.watch();
        break;
      case 'applied': {
        const f = this.field(msg.gid);
        if (!f) return;
        if (msg.ok) Object.assign(f, { status: 'fill', value: msg.value, values: msg.values || [], applied: true, error: '', saved: msg.saved, sources: msg.saved ? [{ label: 'Saved answer' }] : f.sources });
        else f.error = msg.error || 'Could not fill this field.';
        break;
      }
      case 'undone': {
        const f = this.field(msg.gid);
        if (f && msg.ok) Object.assign(f, { status: 'ask', applied: false, note: 'Undone. Fill it again here if you want.' });
        break;
      }
      case 'error':
        return this.fail(msg.message);
      default:
        return;
    }
    this.render();
  }

  fail(message) {
    this.state = { ...this.state, view: 'error', error: message };
    this.render();
  }

  field(gid) {
    return this.state.fields.find((f) => f.gid === gid);
  }

  // Multi-page forms (Google Forms sections, "Next" buttons) swap questions
  // in place. Offer to fill the new ones instead of making the person rescan.
  watch() {
    this.stopWatching();
    let timer = null;
    this.observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const n = countNew();
        if (n !== this.state.newFields) {
          this.state.newFields = n;
          if (this.state.view === 'results' || this.state.view === 'empty') this.render();
        }
      }, 700);
    });
    // Sections often appear by flipping hidden/class/style, not by adding nodes.
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden'] });
  }

  stopWatching() {
    this.observer?.disconnect();
    this.observer = null;
  }

  // ------------------------------------------------------------ events

  onClick(e) {
    if (!__TEST__ && !e.isTrusted) return; // the page can't press our buttons
    if (this.suppressClick) return;
    const target = e.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    const card = target.closest('[data-gid]');
    const gid = card?.dataset.gid;
    switch (act) {
      case 'close':
        return this.hide();
      case 'min':
        return this.minimize();
      case 'restore':
        this.minimized = false;
        this.panel.hidden = false;
        this.pill.hidden = true;
        return this.place();
      case 'rescan':
      case 'retry':
        return this.start();
      case 'stop':
        this.send({ type: 'cancel' });
        return this.fail('Stopped. Nothing else will be filled.');
      case 'settings':
        return this.send({ type: 'open-options' });
      case 'focus':
        return this.send({ type: 'focus', gid });
      case 'undo':
        return this.send({ type: 'undo', gid });
      case 'once':
      case 'save':
      case 'insert':
        return this.apply(card, act);
      default:
    }
  }

  onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && e.target.matches('input.in')) {
      e.preventDefault();
      const card = e.target.closest('[data-gid]');
      if (card) this.apply(card, 'once');
    }
    if (e.key === 'Escape') this.minimize();
    e.stopPropagation(); // keep typing in the panel away from page shortcuts
  }

  apply(card, act) {
    const f = this.field(card.dataset.gid);
    if (!f) return;
    let value = '';
    let values = [];
    if (f.multiple) values = [...card.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    else if (f.options?.length && !TEXTISH.has(f.kind)) value = card.querySelector('input[type=radio]:checked')?.value || card.querySelector('select.in')?.value || '';
    else value = card.querySelector('.in')?.value?.trim() || '';
    if (!value && !values.length && f.kind !== 'file') {
      f.error = 'Pick or type an answer first.';
      return this.render();
    }
    f.error = '';
    card.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
    this.send({ type: 'apply', gid: f.gid, value, values, save: act === 'save' ? { question: f.label } : null });
  }

  // ------------------------------------------------------------ render

  // Whatever the person is halfway through typing or ticking in any card
  // survives a re-render (another answer landing, the page changing).
  capture() {
    const typed = new Map();
    for (const card of this.body.querySelectorAll('[data-gid]')) {
      const inputs = [...card.querySelectorAll('input, textarea, select')];
      if (inputs.length) typed.set(card.dataset.gid, inputs.map((i) => (i.type === 'checkbox' || i.type === 'radio' ? i.checked : i.value)));
    }
    const active = this.root.activeElement;
    const activeCard = active?.closest?.('[data-gid]');
    const focus = activeCard ? { gid: activeCard.dataset.gid, index: [...activeCard.querySelectorAll('input, textarea, select')].indexOf(active) } : null;
    const open = new Map([...this.body.querySelectorAll('details.sec')].map((d) => [d.querySelector('summary').textContent.split(' · ')[0], d.open]));
    return { typed, focus, open };
  }

  restore({ typed, focus, open }) {
    for (const card of this.body.querySelectorAll('[data-gid]')) {
      const saved = typed.get(card.dataset.gid);
      const inputs = [...card.querySelectorAll('input, textarea, select')];
      if (!saved || saved.length !== inputs.length) continue;
      inputs.forEach((input, i) => {
        if (input.type === 'checkbox' || input.type === 'radio') input.checked = saved[i];
        else input.value = saved[i];
      });
    }
    for (const d of this.body.querySelectorAll('details.sec')) {
      const was = open.get(d.querySelector('summary').textContent.split(' · ')[0]);
      if (was !== undefined) d.open = was;
    }
    this.refocus(focus);
  }

  refocus(spot) {
    if (!spot || spot.index < 0) return;
    const card = [...this.body.querySelectorAll('[data-gid]')].find((c) => c.dataset.gid === spot.gid);
    card?.querySelectorAll('input, textarea, select')[spot.index]?.focus({ preventScroll: true });
  }

  render() {
    const s = this.state;
    const keepScroll = this.body.scrollTop;
    const kept = s.view === 'results' ? this.capture() : null;
    let html = '';
    if (s.view === 'setup') html = this.viewSetup();
    else if (s.view === 'working') html = this.viewWorking();
    else if (s.view === 'error') html = this.viewError();
    else if (s.view === 'empty') html = this.viewEmpty();
    else if (s.view === 'results') html = this.viewResults();
    this.body.innerHTML = html;
    if (kept) this.restore(kept);
    this.body.scrollTop = keepScroll;
    const open = this.state.fields.filter((f) => ['ask', 'sensitive', 'consent', 'draft'].includes(f.status) && !f.applied).length;
    const badge = this.pill.querySelector('.badge');
    badge.hidden = !open;
    badge.textContent = String(open);
    this.meta.textContent = s.cost != null && s.view === 'results' ? `This form: about $${s.cost.toFixed(2)} · never submits` : 'Never submits. You check, then you submit.';
    this.place();
  }

  viewSetup() {
    const missing = this.state.missing || [];
    const needs = [missing.includes('key') && 'your Claude API key', missing.includes('profile') && 'your resume'].filter(Boolean).join(' and ');
    return `<div class="hero">${logo(48)}
      <h2>Let's set you up</h2>
      <p>fill.ai needs ${h(needs || 'a little setup')} before it can fill forms for you. It takes about a minute.</p>
      <button class="btn primary big" data-act="settings">Open fill.ai settings</button></div>`;
  }

  viewWorking() {
    const p = this.state.progress || {};
    const at = STEPS.findIndex(([k]) => k === p.stage);
    const steps = STEPS.map(([k, label], i) => {
      let text = label;
      if (k === 'reading' && p.total) text = `Read ${p.total} question${p.total === 1 ? '' : 's'}`;
      if (k === 'thinking' && i === at && p.total) text = p.done ? `Answering · ${p.done} of ${p.total}` : 'Thinking it through';
      return `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"><span class="dot"></span>${h(text)}</li>`;
    }).join('');
    const pct = p.total && p.stage === 'thinking' ? Math.round((100 * (p.done || 0)) / p.total) : p.stage === 'filling' ? 100 : 6;
    return `<div class="hero"><div class="orb"></div><ul class="steps">${steps}</ul>
      <div class="meter"><i style="width:${pct}%"></i></div>
      <button class="btn" data-act="stop">Stop</button></div>`;
  }

  viewError() {
    return `<div class="hero"><h2>Something went wrong</h2><p>${h(this.state.error)}</p>
      <div class="row" style="justify-content:center"><button class="btn" data-act="settings">Settings</button><button class="btn primary" data-act="retry">Try again</button></div></div>`;
  }

  viewEmpty() {
    const n = this.state.newFields;
    return `<div class="hero"><h2>No form here yet</h2><p>fill.ai couldn't find any fields it can fill on this page. If the form is still loading, try again in a moment.</p>
      <button class="btn primary" data-act="rescan">${n ? `Fill ${n} new field${n === 1 ? '' : 's'}` : 'Look again'}</button></div>`;
  }

  viewResults() {
    const fields = this.state.fields;
    const by = (pred) => fields.filter(pred);
    const asks = by((f) => f.status === 'ask' && !f.applied);
    const drafts = by((f) => f.status === 'draft' && !f.applied);
    const yours = by((f) => (f.status === 'sensitive' || f.status === 'consent') && !f.applied);
    const filled = by((f) => f.status === 'fill');
    const quiet = by((f) => f.status === 'keep' || f.status === 'skip');

    const chip = (cls, n, word) => (n ? `<span class="chip ${cls}"><span class="dot"></span><b>${n}</b> ${word}</span>` : '');
    let html = `<div class="chips">${chip('c-fill', filled.length, 'filled')}${chip('c-ask', asks.length, asks.length === 1 ? 'needs you' : 'need you')}${chip('c-draft', drafts.length, drafts.length === 1 ? 'draft' : 'drafts')}${chip('c-yours', yours.length, 'your call')}</div>`;

    if (this.state.newFields) {
      html += `<div class="banner"><span>${this.state.newFields} new question${this.state.newFields === 1 ? '' : 's'} appeared.</span><button class="btn primary" data-act="rescan">Fill them</button></div>`;
    }
    if (!asks.length && !drafts.length && !yours.length) {
      html += `<p class="done-note">All set. Look over the form, then submit it yourself.</p>`;
    }
    const section = (title, items, render, open = true) =>
      items.length ? `<details class="sec" ${open ? 'open' : ''}><summary>${title} · ${items.length}</summary><div class="list">${items.map(render).join('')}</div></details>` : '';

    html += section('Needs you', asks, (f) => this.askCard(f, 'ask'));
    html += section('Drafts', drafts, (f) => this.draftCard(f));
    html += section('Your call', yours, (f) => this.askCard(f, 'yours'));
    html += section('Filled', filled, (f) => this.filledRow(f), filled.length <= 12 || !asks.length);
    if (quiet.length) {
      html += section('Left alone', quiet, (f) => `<div class="muted-row" data-gid="${h(f.gid)}"><span class="q" data-act="focus">${h(f.label)}</span>${f.status === 'keep' ? ' · already filled' : ''}</div>`, false);
    }
    if (this.state.dropped) {
      html += `<p class="hint">${this.state.dropped} private field${this.state.dropped === 1 ? '' : 's'} (passwords, codes, card details) left alone on purpose.</p>`;
    }
    return html;
  }

  askCard(f, tone) {
    const control = this.control(f);
    const canSave = f.kind !== 'file' && f.status !== 'consent';
    const buttons =
      f.kind === 'file'
        ? `<button class="btn" data-act="focus">Show me</button>`
        : `<button class="btn" data-act="once">Fill once</button>${canSave ? `<button class="btn primary" data-act="save" title="Fill it and remember for next time">Save &amp; fill</button>` : ''}`;
    return `<div class="card ${tone === 'yours' ? 'yours' : ''}" data-gid="${h(f.gid)}">
      <div class="q" data-act="focus">${h(f.label)}${f.required ? '<span class="req">*</span>' : ''}</div>
      ${f.note ? `<div class="hint">${h(f.note)}</div>` : ''}
      ${control}
      ${f.error ? `<div class="err">${h(f.error)}</div>` : ''}
      <div class="row">${buttons}</div></div>`;
  }

  draftCard(f) {
    return `<div class="card draft" data-gid="${h(f.gid)}">
      <div class="q" data-act="focus">${h(f.label)}</div>
      <div class="hint">Written from your profile. Read it and edit it before you insert it.</div>
      <textarea class="in" rows="6">${h(f.value)}</textarea>
      ${this.sources(f)}
      ${f.error ? `<div class="err">${h(f.error)}</div>` : ''}
      <div class="row"><button class="btn primary" data-act="insert">Insert</button></div></div>`;
  }

  filledRow(f) {
    const shown = f.values?.length ? f.values.join(', ') : f.kind === 'file' ? 'Resume attached' : f.value;
    return `<div class="frow" data-gid="${h(f.gid)}">
      <span class="q" data-act="focus">${h(f.label)}</span>
      <button class="icon" data-act="undo" title="Undo" aria-label="Undo ${h(f.label)}">&#8634;</button>
      <span class="v" title="${h(shown)}">${h(shown)}</span>
      ${this.sources(f)}</div>`;
  }

  sources(f) {
    const labels = [...new Set((f.sources || []).map((s) => s.label).filter(Boolean))].slice(0, 3);
    return labels.length ? `<div class="src">${labels.map((l) => `<span>${h(l)}</span>`).join('')}</div>` : '';
  }

  control(f) {
    const suggestion = f.value || '';
    if (f.kind === 'file') return '';
    if (f.multiple && f.options?.length) {
      return `<div class="opts">${f.options
        .map((o) => `<label class="opt"><input type="checkbox" value="${h(o)}" ${(f.values || []).includes(o) ? 'checked' : ''}><span>${h(o)}</span></label>`)
        .join('')}</div>`;
    }
    if (f.options?.length && !TEXTISH.has(f.kind)) {
      if (f.options.length <= 6) {
        const name = `o-${f.gid.replace(/\W/g, '')}`;
        return `<div class="opts">${f.options
          .map((o) => `<label class="opt"><input type="radio" name="${name}" value="${h(o)}" ${o === suggestion ? 'checked' : ''}><span>${h(o)}</span></label>`)
          .join('')}</div>`;
      }
      return `<select class="in"><option value="">Choose…</option>${f.options.map((o) => `<option ${o === suggestion ? 'selected' : ''}>${h(o)}</option>`).join('')}</select>`;
    }
    if (f.kind === 'textarea' || f.kind === 'richtext') return `<textarea class="in" rows="4" placeholder="Type your answer">${h(suggestion)}</textarea>`;
    const type = { date: 'date', month: 'month', time: 'time', email: 'email', tel: 'tel', url: 'url', number: 'number' }[f.kind] || 'text';
    return `<input class="in" type="${type}" value="${h(suggestion)}" placeholder="${h(f.placeholder || 'Type your answer')}">`;
  }
}

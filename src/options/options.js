// Fill.ai settings and profile page: choose the AI, build the profile from
// documents, edit what Fill.ai knows, manage saved answers and data.

import { LONG_TEXT, PROFILE_SCHEMA, SECTION_TITLES, conform, emptyFrom, isProfileEmpty } from '../shared/schema.js';
import {
  getFacts,
  getProfile,
  getResumeFile,
  getSettings,
  saveFacts,
  saveProfile,
  saveResumeFile,
  saveSettings,
  saveSources,
  wipeEverything,
} from '../shared/storage.js';
import { PROVIDERS, askJson, isConnected, providerOf } from '../shared/ai/index.js';
import { DEFAULT_URL, RECOMMENDED } from '../shared/ai/ollama.js';
import { DEFAULT_MODEL as GEMINI_DEFAULT, MODELS as GEMINI_MODELS } from '../shared/ai/gemini.js';
import { PROFILE_SYSTEM } from '../shared/prompts.js';
import { pdfText } from './pdf-text.js';

const $ = (sel) => document.querySelector(sel);
let chosen = []; // files picked in step 2: { name, type, size, data }
let draft = null; // profile being edited
let saved = null; // last saved profile, as JSON, for dirty checks

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
}

function status(target, text, kind = '') {
  const node = $(target);
  node.textContent = text;
  node.className = `status ${kind}`;
}

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}

function humanize(key) {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function kb(bytes) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// ------------------------------------------------------------------ readiness

async function refreshReadiness() {
  const [settings, profile, facts] = await Promise.all([getSettings(), getProfile(), getFacts()]);
  const aiOk = isConnected(settings);
  const profileOk = !isProfileEmpty(profile) || facts.length > 0;
  $('#connect').classList.toggle('done', aiOk);
  $('#teach').classList.toggle('done', profileOk);
  const r = $('#readiness');
  const left = [!aiOk, !profileOk].filter(Boolean).length;
  r.textContent = left ? `${left} step${left > 1 ? 's' : ''} to go` : 'Ready on every form';
  r.className = `readiness ${left ? 'todo' : 'ready'}`;
}

// ------------------------------------------------------------------ step 1: the AI

function paintProvider(id) {
  document.querySelectorAll('#providers .prov').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.provider === id)));
  document.querySelectorAll('.prov-panel').forEach((p) => (p.hidden = p.dataset.for !== id));
}

function gb(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function pullCommand(model) {
  const cmd = `ollama pull ${model}`;
  return el(
    'span',
    { class: 'cmd' },
    el('code', {}, cmd),
    el('button', { class: 'ghost small', type: 'button', onclick: () => navigator.clipboard.writeText(cmd).then(() => toast('Copied. Paste it into a terminal.')) }, 'Copy'),
  );
}

function ollamaHelp(...kids) {
  const help = $('#ollamaHelp');
  help.replaceChildren(...kids);
  help.hidden = !kids.length;
}

// Is Ollama up, which chat models does it have, and which one do we use?
// Picks the recommended model by itself when it is installed.
let ollamaRun = 0;
async function checkOllama() {
  const run = ++ollamaRun;
  const settings = await getSettings();
  status('#ollamaStatus', 'Looking for Ollama…', 'busy');
  let found;
  try {
    found = await PROVIDERS.ollama.test(settings);
  } catch (err) {
    if (run !== ollamaRun) return;
    $('#ollamaModelWrap').hidden = true;
    status('#ollamaStatus', err.message, 'bad');
    if (err.code === 'offline') {
      ollamaHelp(
        el('p', {}, 'To run the AI on this computer:'),
        el(
          'ol',
          {},
          el('li', {}, 'Install Ollama from ', el('a', { href: 'https://ollama.com/download', target: '_blank', rel: 'noopener' }, 'ollama.com'), ' and open it.'),
          el('li', {}, 'In a terminal, download the model once (3.4 GB): ', pullCommand(RECOMMENDED)),
          el('li', {}, 'Come back and press Check again.'),
        ),
        el('p', { class: 'faint' }, 'No graphics card? Gemini is the easier free choice.'),
      );
    } else ollamaHelp();
    return;
  }
  if (run !== ollamaRun) return;
  const { version, models } = found;
  if (!models.length) {
    $('#ollamaModelWrap').hidden = true;
    status('#ollamaStatus', `Ollama ${version} is running, but it has no chat models yet.`, 'bad');
    ollamaHelp(el('p', {}, 'Download one in a terminal (3.4 GB, once): ', pullCommand(RECOMMENDED), ' then press Check again.'));
    if (settings.ollamaModel) await saveSettings({ ollamaModel: '' });
    return refreshReadiness();
  }

  const names = models.map((m) => m.name);
  let chosen = settings.ollamaModel;
  if (!names.includes(chosen)) chosen = names.includes(RECOMMENDED) ? RECOMMENDED : names[0];
  if (chosen !== settings.ollamaModel) await saveSettings({ ollamaModel: chosen });
  $('#ollamaModel').replaceChildren(
    ...models.map((m) =>
      el('option', { value: m.name, selected: m.name === chosen }, [m.name, m.size && gb(m.size), m.name === RECOMMENDED && 'recommended'].filter(Boolean).join(' · ')),
    ),
  );
  $('#ollamaModelWrap').hidden = false;
  status('#ollamaStatus', `Ollama ${version} is running. ${models.length} model${models.length > 1 ? 's' : ''} ready.`, 'ok');
  if (names.includes(RECOMMENDED)) ollamaHelp();
  else ollamaHelp(el('p', {}, `For the best answers on a laptop graphics card, add ${RECOMMENDED} (3.4 GB): `, pullCommand(RECOMMENDED)));
  refreshReadiness();
}

// Gemini and Claude: paste a key, save it, check it.
function wireKey(id, settings) {
  const field = `${id}Key`;
  const input = $(`#${field}`);
  const button = $(`#save${id[0].toUpperCase()}${id.slice(1)}`);
  input.value = settings[field];
  if (settings[field]) status(`#${id}Status`, 'Key saved.', 'ok');
  button.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) return status(`#${id}Status`, 'Paste your key first.', 'bad');
    const next = await saveSettings({ [field]: key, provider: id });
    button.disabled = true;
    status(`#${id}Status`, `Checking the key with ${PROVIDERS[id].name}…`, 'busy');
    try {
      const { detail } = await PROVIDERS[id].test(next);
      status(`#${id}Status`, detail, 'ok');
    } catch (err) {
      status(`#${id}Status`, err.message, 'bad');
    } finally {
      button.disabled = false;
      refreshReadiness();
    }
  });
}

async function initConnect() {
  const settings = await getSettings();
  paintProvider(settings.provider);
  $('#providers').addEventListener('click', async (e) => {
    const b = e.target.closest('.prov');
    if (!b) return;
    paintProvider(b.dataset.provider);
    await saveSettings({ provider: b.dataset.provider });
    if (b.dataset.provider === 'ollama') checkOllama();
    refreshReadiness();
  });
  document.querySelectorAll('.reveal').forEach((btn) =>
    btn.addEventListener('click', () => {
      const input = $(`#${btn.dataset.for}`);
      input.type = input.type === 'password' ? 'text' : 'password';
      btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
    }),
  );
  wireKey('gemini', settings);
  wireKey('claude', settings);

  $('#ollamaURL').value = settings.ollamaURL;
  $('#ollamaURL').addEventListener('change', async () => {
    await saveSettings({ ollamaURL: $('#ollamaURL').value.trim() || DEFAULT_URL, ollamaModel: '' });
    checkOllama();
  });
  $('#checkOllama').addEventListener('click', checkOllama);
  $('#ollamaModel').addEventListener('change', async () => {
    await saveSettings({ ollamaModel: $('#ollamaModel').value });
    toast(`Using ${$('#ollamaModel').value}.`);
    refreshReadiness();
  });

  $('#geminiModels').replaceChildren(...GEMINI_MODELS.map((m) => el('option', { value: m })));
  $('#geminiModel').value = settings.geminiModel;
  $('#geminiModel').addEventListener('change', async () => {
    await saveSettings({ geminiModel: $('#geminiModel').value.trim() || GEMINI_DEFAULT });
    toast('Saved.');
  });
  $('#claudeBaseURL').value = settings.claudeBaseURL;
  $('#claudeBaseURL').addEventListener('change', async () => {
    await saveSettings({ claudeBaseURL: $('#claudeBaseURL').value.trim() });
    toast('Saved.');
  });
  if (settings.provider === 'ollama') checkOllama();
}

// ------------------------------------------------------------------ step 2: build

const ACCEPT = /\.(pdf|txt|md|png|jpe?g|webp)$/i;

async function addFiles(list) {
  for (const file of list) {
    if (!ACCEPT.test(file.name)) {
      toast(`${file.name}: Fill.ai reads PDF, text and image files. Save Word files as PDF first.`);
      continue;
    }
    if (file.size > 20e6) {
      toast(`${file.name} is over 20 MB.`);
      continue;
    }
    const type = file.type || (file.name.endsWith('.md') ? 'text/markdown' : 'text/plain');
    chosen.push({ name: file.name, type, size: file.size, data: await readFile(file) });
  }
  renderFiles();
}

function renderFiles() {
  const list = $('#fileList');
  list.replaceChildren(
    ...chosen.map((f, i) =>
      el(
        'li',
        {},
        el('span', { class: 'name' }, f.name),
        el('span', { class: 'size' }, kb(f.size)),
        el('button', { class: 'ghost small', type: 'button', onclick: () => (chosen.splice(i, 1), renderFiles()) }, 'Remove'),
      ),
    ),
  );
}

function initDrop() {
  const drop = $('#drop');
  $('#files').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add('over'))));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });
}

// Open a link in a background tab so pages that render with JavaScript (most
// portfolios, LinkedIn) give up their real text, then close it again.
async function readLink(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => (chrome.tabs.onUpdated.removeListener(listener), reject(new Error('timed out'))), 25000);
      function listener(id, info) {
        if (id === tab.id && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise((r) => setTimeout(r, 1800));
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => (document.body ? document.body.innerText : '') });
    return String(res?.result || '')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 60000);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

const READING = {
  ollama: (s) => `${s.ollamaModel} is reading your documents on this computer. The first run loads the model, so give it a few minutes.`,
  gemini: () => 'Gemini is reading your documents. This usually takes under a minute.',
  claude: () => 'Claude is reading your documents. This usually takes a minute or two.',
};

async function build() {
  const settings = await getSettings();
  const provider = providerOf(settings);
  if (!provider.isConnected(settings)) return status('#buildStatus', 'Choose the AI in step 1 first.', 'bad');
  const urls = $('#urls')
    .value.split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`));
  const notes = $('#notes').value.trim();
  if (!chosen.length && !urls.length && !notes) return status('#buildStatus', 'Add your resume, a link or some notes first.', 'bad');

  const current = await getProfile();
  if (!isProfileEmpty(current) && !confirm('Build a fresh profile from these documents? It replaces what was read from documents before. Your saved answers stay.')) return;

  $('#build').disabled = true;
  const content = [];
  const sources = [];
  try {
    for (const f of chosen) {
      const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      if (isPdf && provider.readsPdf) {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name });
      } else if (isPdf) {
        // Local models read text only. pdf.js does the reading, on this computer.
        status('#buildStatus', `Reading ${f.name}…`, 'busy');
        let text = '';
        try {
          text = await pdfText(f.data);
        } catch (err) {
          console.warn('Fill.ai: could not read', f.name, err);
        }
        if (text.replace(/\s/g, '').length < 40) {
          toast(`${f.name} has almost no text in it, maybe a scan. Paste its text under "Anything else", or use Gemini for this step.`);
          continue;
        }
        content.push({ type: 'text', text: `Source: ${f.name}\n\n${text}` });
      } else if (f.type.startsWith('image/')) {
        content.push({ type: 'text', text: `Source: ${f.name} (image)` });
        content.push({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } });
      } else {
        const text = new TextDecoder().decode(Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)));
        content.push({ type: 'text', text: `Source: ${f.name}\n\n${text}` });
      }
      sources.push(f.name);
    }
    for (const url of urls) {
      status('#buildStatus', `Opening ${new URL(url).hostname}…`, 'busy');
      try {
        const text = await readLink(url);
        if (text.trim().length < 80) throw new Error('almost no text');
        content.push({ type: 'text', text: `Source: ${url}\n\n${text}` });
        sources.push(url);
      } catch (err) {
        toast(`Couldn't read ${url} (${err.message}). Carrying on without it.`);
      }
    }
    if (notes) {
      content.push({ type: 'text', text: `Source: notes typed by the person\n\n${notes}` });
      sources.push('Your notes');
    }
    if (!content.length) throw new Error('Nothing could be read. Try adding your resume as a PDF.');
    content.push({ type: 'text', text: 'Build the profile from these documents.' });

    status('#buildStatus', READING[provider.id](settings), 'busy');
    const { data, cost } = await askJson({
      settings,
      system: PROFILE_SYSTEM,
      content,
      schema: PROFILE_SCHEMA,
      effort: provider.id === 'ollama' ? 'medium' : 'high',
      onText: (snap) => status('#buildStatus', `Writing your profile… ${Math.round(snap.length / 100) / 10}k characters`, 'busy'),
    });

    await saveProfile(conform(data));
    await saveSources(sources.map((s) => ({ name: s, at: new Date().toISOString() })));
    const pdf = chosen.find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if ($('#useResume').checked && pdf) await saveResumeFile({ name: pdf.name, type: 'application/pdf', size: pdf.size, data: pdf.data });
    status('#buildStatus', `Done${cost != null ? ` · about $${cost.toFixed(2)}` : ''}. Check your profile below.`, 'ok');
    chosen = [];
    renderFiles();
    await loadProfile();
    await renderResumeInfo();
    refreshReadiness();
    $('#profile').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    status('#buildStatus', err.message, 'bad');
  } finally {
    $('#build').disabled = false;
  }
}

// ------------------------------------------------------------------ profile editor

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

function markDirty() {
  $('#savebar').hidden = JSON.stringify(draft) === saved;
}

const COMMA_LISTS = new Set(['items', 'tech']);

function inputFor(key, schema, value, path) {
  if (schema.type === 'boolean') {
    return el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: value, onchange: (e) => (setPath(draft, path, e.target.checked), markDirty()) }), humanize(key));
  }
  if (schema.type === 'array') {
    const comma = COMMA_LISTS.has(key);
    return el(
      'label',
      { class: 'lbl wide' },
      `${humanize(key)} ${comma ? '(comma separated)' : '(one per line)'}`,
      el('textarea', {
        rows: comma ? 2 : Math.min(8, Math.max(2, value.length + 1)),
        value: value.join(comma ? ', ' : '\n'),
        oninput: (e) => {
          const parts = e.target.value.split(comma ? /\s*,\s*/ : /\n/).map((s) => s.trim()).filter(Boolean);
          setPath(draft, path, parts);
          markDirty();
        },
      }),
    );
  }
  const long = LONG_TEXT.has(key);
  const field = long
    ? el('textarea', { rows: 3, value, oninput: (e) => (setPath(draft, path, e.target.value), markDirty()) })
    : el('input', { type: 'text', value, spellcheck: false, oninput: (e) => (setPath(draft, path, e.target.value), markDirty()) });
  return el('label', { class: `lbl${long ? ' wide' : ''}` }, humanize(key), field);
}

function objectFields(schema, value, path) {
  const simple = [];
  const nested = [];
  for (const [key, sub] of Object.entries(schema.properties)) {
    if (sub.type === 'object') nested.push(el('div', { class: 'sub-title wide' }, humanize(key)), ...objectFields(sub, value[key], [...path, key]).children);
    else simple.push(inputFor(key, sub, value[key], [...path, key]));
  }
  return el('div', { class: 'fields' }, ...simple, ...nested);
}

function itemTitle(item) {
  return item.institution || item.company || item.name || item.title || item.role || item.label || item.language || item.category || 'New entry';
}

function renderSection(key, schema) {
  const value = draft[key];
  const count = Array.isArray(value) ? value.length : null;
  const body = el('div', { class: 'sec-body' });
  if (schema.type === 'object') body.append(objectFields(schema, value, [key]));
  else if (schema.items.type === 'object') {
    value.forEach((item, i) => {
      body.append(
        el(
          'div',
          { class: 'item' },
          el(
            'div',
            { class: 'item-head' },
            el('strong', {}, itemTitle(item)),
            el('button', { class: 'ghost small', type: 'button', onclick: () => (value.splice(i, 1), rerender(key)) }, 'Remove'),
          ),
          objectFields(schema.items, item, [key, i]),
        ),
      );
    });
    body.append(
      el(
        'div',
        {},
        el('button', { class: 'ghost small', type: 'button', onclick: () => (value.push(emptyFrom(schema.items)), rerender(key, true)) }, `Add ${SECTION_TITLES[key].toLowerCase().replace(/s$/, '')}`),
      ),
    );
  } else {
    body.append(el('div', { class: 'fields' }, inputFor(key, schema, value, [key])));
  }
  const filled = count == null ? '' : `${count}`;
  return el('details', { class: 'sec', 'data-key': key, open: key === 'basics' }, el('summary', {}, SECTION_TITLES[key], el('span', { class: 'count' }, filled)), body);
}

function rerender(key, focusLast = false) {
  const old = document.querySelector(`details.sec[data-key="${key}"]`);
  const fresh = renderSection(key, PROFILE_SCHEMA.properties[key]);
  fresh.open = true;
  old.replaceWith(fresh);
  markDirty();
  if (focusLast) fresh.querySelector('.item:last-of-type input')?.focus();
}

function renderEditor() {
  const root = $('#profileEditor');
  if (isProfileEmpty(draft)) {
    root.replaceChildren(
      el('p', { class: 'empty' }, 'Nothing here yet. Build your profile in step 2, or fill it in by hand below.'),
      ...Object.entries(PROFILE_SCHEMA.properties).map(([key, schema]) => renderSection(key, schema)),
    );
    return;
  }
  root.replaceChildren(...Object.entries(PROFILE_SCHEMA.properties).map(([key, schema]) => renderSection(key, schema)));
}

async function loadProfile() {
  const profile = await getProfile();
  draft = structuredClone(profile);
  saved = JSON.stringify(profile);
  renderEditor();
  markDirty();
}

function initEditor() {
  $('#saveProfile').addEventListener('click', async () => {
    await saveProfile(draft);
    saved = JSON.stringify(conform(draft));
    draft = conform(draft);
    markDirty();
    toast('Profile saved.');
    refreshReadiness();
  });
  $('#discard').addEventListener('click', loadProfile);
  window.addEventListener('beforeunload', (e) => {
    if (!$('#savebar').hidden) e.preventDefault();
  });
}

// ------------------------------------------------------------------ saved answers

async function renderFacts() {
  const facts = await getFacts();
  const list = $('#factList');
  if (!facts.length) {
    list.replaceChildren(el('p', { class: 'empty' }, 'No saved answers yet. When a form asks something your resume does not cover, choose "Save & fill", or just type it into the form: Fill.ai remembers what you fill in yourself.'));
    return;
  }
  const persist = async () => {
    await saveFacts(facts.filter((f) => f.question.trim() || f.answer.trim()));
  };
  list.replaceChildren(
    ...facts.map((fact, i) => {
      const when = fact.savedAt ? new Date(fact.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      return el(
        'div',
        { class: 'fact' },
        el('input', { type: 'text', value: fact.question, 'aria-label': 'Question', placeholder: 'Question', onchange: (e) => ((fact.question = e.target.value), persist()) }),
        el('textarea', { rows: 1, value: fact.answer, 'aria-label': 'Answer', placeholder: 'Answer', onchange: (e) => ((fact.answer = e.target.value), persist()) }),
        el('button', { class: 'ghost small', type: 'button', onclick: async () => (facts.splice(i, 1), await saveFacts(facts), renderFacts(), refreshReadiness()) }, 'Delete'),
        el('div', { class: 'meta' }, [fact.how === 'typed' ? 'You typed this' : '', fact.site && `${fact.how === 'typed' ? 'on' : 'From'} ${fact.site}`, when].filter(Boolean).join(' · ')),
      );
    }),
  );
}

function initFacts() {
  $('#addFact').addEventListener('click', async () => {
    const facts = await getFacts();
    facts.push({ question: '', answer: '', site: '', savedAt: new Date().toISOString() });
    await saveFacts(facts);
    await renderFacts();
    const inputs = $('#factList').querySelectorAll('.fact input');
    inputs[inputs.length - 1]?.focus();
  });
}

// ------------------------------------------------------------------ settings

async function initSettings() {
  const settings = await getSettings();
  const seg = $('#effort');
  const paint = (effort) => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.effort === effort)));
  paint(settings.effort);
  seg.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    paint(b.dataset.effort);
    await saveSettings({ effort: b.dataset.effort });
    toast(`Set to ${b.textContent}.`);
  });
  $('#changeShortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  try {
    const commands = await chrome.commands.getAll();
    const main = commands.find((c) => c.name === '_execute_action');
    if (main) $('#shortcut').textContent = main.shortcut || 'Not set';
  } catch {}
  $('#removeResume').addEventListener('click', async () => {
    await chrome.storage.local.remove('resumeFile');
    renderResumeInfo();
  });
  await renderResumeInfo();
}

async function renderResumeInfo() {
  const file = await getResumeFile();
  $('#resumeFileInfo').textContent = file ? `${file.name} · ${kb(file.size || 0)}. Attached when a form asks for a resume.` : 'No file saved. Add a PDF in step 2 to attach it to resume upload fields.';
  $('#removeResume').hidden = !file;
}

// ------------------------------------------------------------------ data

function initData() {
  $('#exportData').addEventListener('click', async () => {
    const [profile, facts] = await Promise.all([getProfile(), getFacts()]);
    const blob = new Blob([JSON.stringify({ app: 'fill.ai', version: 1, exportedAt: new Date().toISOString(), profile, facts }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'fill-ai-profile.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importData').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.profile) throw new Error('This is not a Fill.ai export.');
      if (!confirm('Replace your profile and saved answers with this file?')) return;
      await saveProfile(conform(data.profile));
      if (Array.isArray(data.facts)) await saveFacts(data.facts.filter((f) => f && typeof f.question === 'string' && typeof f.answer === 'string'));
      await Promise.all([loadProfile(), renderFacts()]);
      refreshReadiness();
      toast('Imported.');
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });
  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Delete your profile, saved answers, resume file and API keys from this browser? This cannot be undone.')) return;
    await wipeEverything();
    location.reload();
  });
}

// ------------------------------------------------------------------ boot

// Answers saved from a form while this page is open show up live, but never
// re-render under someone who is typing in the list.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.facts && !$('#factList').contains(document.activeElement)) renderFacts();
});

(async () => {
  initDrop();
  $('#build').addEventListener('click', build);
  initEditor();
  initFacts();
  initData();
  await Promise.all([initConnect(), initSettings(), loadProfile(), renderFacts()]);
  refreshReadiness();
})();

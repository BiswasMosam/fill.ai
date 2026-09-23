// fill.ai service worker. It runs the loop the panel asks for: read every
// frame of the tab, ask Claude, check the answers, fill what passed, report.
// It holds no state between messages; the panel keeps the picture.

import { getKnowledge, getResumeFile, getSettings, rememberFact } from '../shared/storage.js';
import { isProfileEmpty } from '../shared/schema.js';
import { askJson } from '../shared/claude.js';
import { ANSWERS_SCHEMA, formSystemPrompt, formUserContent } from '../shared/prompts.js';
import { estimateCost, modelView, prepareFields, validateAnswers } from '../shared/matcher.js';
import { textOf } from '../shared/paths.js';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' && !__TEST__) chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener((tab) => openPanel(tab));

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch {
    // A frame we may not touch (another extension's iframe, a sandboxed
    // frame) can fail the whole call. The top frame is what matters most.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function openPanel(tab) {
  if (!tab?.id) return;
  try {
    await inject(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__fillai?.togglePanel() });
  } catch {
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#f5b544' });
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    chrome.action.setTitle({ tabId: tab.id, title: "fill.ai can't run on this page. Browser pages and the Chrome Web Store are off limits." });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 4000);
  }
}

// Run a self-contained function in the content script of some or all frames.
async function inFrames(tabId, func, args = [], frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  return chrome.scripting.executeScript({ target, func, args });
}

function splitGid(gid) {
  const i = gid.indexOf(':');
  return [Number(gid.slice(0, i)), gid.slice(i + 1)];
}

function post(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Panel closed while we were working. Nothing to tell.
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fillai-panel') return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;
  let abort = null;
  port.onDisconnect.addListener(() => abort?.abort());
  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg.type) {
        case 'analyze':
          abort?.abort();
          abort = new AbortController();
          await analyze(port, tabId, abort.signal);
          break;
        case 'cancel':
          abort?.abort();
          break;
        case 'apply':
          await applyOne(port, tabId, msg);
          break;
        case 'undo':
          await undoOne(port, tabId, msg.gid);
          break;
        case 'focus': {
          const [frameId, id] = splitGid(msg.gid);
          await inFrames(tabId, (fid) => window.__fillai?.focus(fid), [id], [frameId]);
          break;
        }
        case 'clear-marks':
          await inFrames(tabId, () => window.__fillai?.clearMarks());
          break;
        case 'open-options':
          chrome.runtime.openOptionsPage();
          break;
        default:
      }
    } catch (err) {
      if (err?.code === 'aborted' || abort?.signal.aborted) return;
      post(port, { type: 'error', message: err?.message || 'Something went wrong.' });
    }
  });
});

async function analyze(port, tabId, signal) {
  const [settings, knowledge, resume] = await Promise.all([getSettings(), getKnowledge(), getResumeFile()]);
  const missing = [];
  if (!settings.apiKey) missing.push('key');
  if (isProfileEmpty(knowledge) && !knowledge.facts.length) missing.push('profile');
  if (missing.length) return post(port, { type: 'needs-setup', missing });

  post(port, { type: 'progress', stage: 'reading' });
  await inject(tabId);
  const frames = await inFrames(tabId, () => window.__fillai?.scan() ?? null);
  let page = null;
  const scanned = [];
  for (const r of frames) {
    if (!r.result) continue;
    if (r.frameId === 0) page = r.result.context;
    for (const f of r.result.fields) scanned.push({ ...f, gid: `${r.frameId}:${f.id}`, frameId: r.frameId });
  }
  const { fields, dropped } = prepareFields(scanned);
  if (!fields.length) return post(port, { type: 'result', fields: [], dropped });

  const total = fields.length;
  const knowledgeText = textOf(knowledge);
  post(port, { type: 'progress', stage: 'thinking', total, done: 0 });
  const resumeOnFile = !!resume?.data;

  // Long Claude calls must not let the worker fall asleep mid-request.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  let result;
  try {
    let shown = 0;
    let lastPost = 0;
    result = await askJson({
      settings,
      effort: settings.effort,
      signal,
      system: formSystemPrompt(knowledge),
      content: formUserContent({ fields: fields.map((f) => modelView(f, knowledgeText)), page, resumeOnFile }),
      schema: ANSWERS_SCHEMA,
      onText: (snapshot) => {
        const done = Math.min(total, (snapshot.match(/"field_id"/g) || []).length);
        const now = Date.now();
        if (done !== shown && now - lastPost > 200) {
          shown = done;
          lastPost = now;
          post(port, { type: 'progress', stage: 'thinking', total, done });
        }
      },
    });
  } finally {
    clearInterval(keepAlive);
  }
  if (signal.aborted) return;

  const decisions = validateAnswers({ fields, answers: result.data.answers, knowledge, resumeOnFile });
  post(port, { type: 'progress', stage: 'filling', total });
  await fillDecisions(tabId, fields, decisions);
  if (signal.aborted) return;
  await markAll(tabId, decisions);

  post(port, {
    type: 'result',
    fields: fields.map((f, i) => ({
      gid: f.gid,
      label: f.label,
      kind: f.kind,
      options: f.options || [],
      multiple: !!f.multiple,
      required: !!f.required,
      placeholder: f.placeholder || '',
      ...decisions[i],
    })),
    cost: estimateCost(result.usage),
    dropped,
  });
}

async function fillDecisions(tabId, fields, decisions) {
  const byFrame = new Map();
  decisions.forEach((d, i) => {
    if (d.status !== 'fill') return;
    const { frameId } = fields[i];
    const [, id] = splitGid(d.gid);
    if (!byFrame.has(frameId)) byFrame.set(frameId, []);
    byFrame.get(frameId).push({ id, value: d.value, values: d.values, gid: d.gid });
  });
  for (const [frameId, items] of byFrame) {
    let results = [];
    try {
      const [res] = await inFrames(tabId, (list) => window.__fillai?.fill(list), [items.map(({ id, value, values }) => ({ id, value, values }))], [frameId]);
      results = res?.result || [];
    } catch {
      results = [];
    }
    for (const item of items) {
      const r = results.find((x) => x.id === item.id);
      if (r?.ok) continue;
      const d = decisions.find((x) => x.gid === item.gid);
      d.status = 'ask';
      d.note = r?.error || 'Could not fill this field automatically.';
    }
  }
}

const MARK = { fill: 'fill', ask: 'ask', draft: 'draft', sensitive: 'sensitive', consent: 'consent' };

async function markAll(tabId, decisions) {
  const byFrame = new Map();
  for (const d of decisions) {
    const [frameId, id] = splitGid(d.gid);
    if (!byFrame.has(frameId)) byFrame.set(frameId, {});
    byFrame.get(frameId)[id] = MARK[d.status] || '';
  }
  for (const [frameId, marks] of byFrame) {
    await inFrames(tabId, (m) => window.__fillai?.mark(m), [marks], [frameId]).catch(() => {});
  }
}

async function applyOne(port, tabId, msg) {
  const [frameId, id] = splitGid(msg.gid);
  const values = msg.values || [];
  const [res] = await inFrames(tabId, (list) => window.__fillai?.fill(list), [[{ id, value: msg.value || '', values }]], [frameId]);
  const r = res?.result?.[0];
  if (!r?.ok) return post(port, { type: 'applied', gid: msg.gid, ok: false, error: r?.error || 'Could not fill this field.' });
  let saved = false;
  if (msg.save?.question) {
    const answer = values.length ? values.join(', ') : msg.value;
    let site = '';
    try {
      site = new URL(port.sender.url).hostname;
    } catch {}
    await rememberFact({ question: msg.save.question, answer, site });
    saved = true;
  }
  await inFrames(tabId, (m) => window.__fillai?.mark(m), [{ [id]: 'fill' }], [frameId]).catch(() => {});
  post(port, { type: 'applied', gid: msg.gid, ok: true, value: msg.value, values, saved });
}

async function undoOne(port, tabId, gid) {
  const [frameId, id] = splitGid(gid);
  const [res] = await inFrames(tabId, (ids) => window.__fillai?.undo(ids), [[id]], [frameId]);
  const ok = !!res?.result?.[0]?.ok;
  if (ok) await inFrames(tabId, (m) => window.__fillai?.mark(m), [{ [id]: 'ask' }], [frameId]).catch(() => {});
  post(port, { type: 'undone', gid, ok });
}

if (__TEST__) {
  // The e2e harness can't click the toolbar button, so it calls this instead.
  globalThis.fillaiTest = {
    async openPanel(urlPart) {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.filter((t) => t.url?.includes(urlPart)).at(-1);
      await openPanel(tab);
      return tab?.id;
    },
  };
}

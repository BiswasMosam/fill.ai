// Fill.ai service worker. It runs the loop the panel asks for: read every
// frame of the tab, ask the chosen AI, check the answers, fill what passed, report.
// It holds no state between messages; the panel keeps the picture.

import { forgetFact, getKnowledge, getResumeFile, getSettings, rememberFact, rememberFacts } from '../shared/storage.js';
import { isProfileEmpty } from '../shared/schema.js';
import { askJson, isConnected } from '../shared/ai/index.js';
import { ANSWERS_SCHEMA, formSystemPrompt, formUserContent } from '../shared/prompts.js';
import { keepMine, learnFrom, modelView, prepareFields, validateAnswers } from '../shared/matcher.js';
import { isDateField } from '../shared/dates.js';
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
    chrome.action.setTitle({ tabId: tab.id, title: "Fill.ai can't run on this page. Browser pages and the Chrome Web Store are off limits." });
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
        case 'forget':
          post(port, { type: 'forgotten', gid: msg.gid, ok: await forgetFact(msg.question || '') });
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

function siteOf(port) {
  try {
    return new URL(port.sender.url).hostname;
  } catch {
    return '';
  }
}

// The panel's picture of one field.
function forPanel(f, d) {
  const out = {
    gid: f.gid,
    label: f.label,
    kind: f.kind,
    options: f.options || [],
    multiple: !!f.multiple,
    required: !!f.required,
    placeholder: f.placeholder || '',
    ...d,
  };
  if (isDateField(f)) out.dateLike = true;
  return out;
}

async function analyze(port, tabId, signal) {
  const [settings, stored, resume] = await Promise.all([getSettings(), getKnowledge(), getResumeFile()]);
  let knowledge = stored;
  const missing = [];
  if (!isConnected(settings)) missing.push('ai');
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
  const { fields: all, dropped } = prepareFields(scanned);
  if (!all.length) return post(port, { type: 'result', fields: [], dropped });

  // Whatever the person already answered stays exactly as it is, and what
  // they typed by hand is remembered for next time (and used for the rest of
  // this form). Only the other questions go to the AI.
  const mine = all.filter((f) => f.mine);
  const fields = all.filter((f) => !f.mine);
  const lessons = mine.map((f) => [f.gid, learnFrom(f)]).filter(([, l]) => l);
  if (lessons.length) {
    const site = siteOf(port);
    await rememberFacts(
      lessons.map(([, l]) => ({ ...l, site })),
      'typed',
    );
    knowledge = await getKnowledge();
  }
  const remembered = new Map(lessons.map(([gid, l]) => [gid, l.question]));
  const kept = mine.map((f) => forPanel(f, keepMine(f, remembered.get(f.gid))));
  if (mine.length) await markAll(tabId, kept);
  if (!fields.length) return post(port, { type: 'result', fields: kept, dropped, via: '' });

  const total = fields.length;
  const knowledgeText = textOf(knowledge);
  post(port, { type: 'progress', stage: 'thinking', total, done: 0 });
  const resumeOnFile = !!resume?.data;

  // Long AI calls (minutes, on a local model) must not let the worker fall
  // asleep mid-request.
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

  // Back in page order, the person's own answers among the rest.
  const byGid = new Map([...fields.map((f, i) => [f.gid, forPanel(f, decisions[i])]), ...kept.map((k) => [k.gid, k])]);
  post(port, {
    type: 'result',
    fields: all.map((f) => byGid.get(f.gid)),
    cost: result.cost,
    via: result.via,
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
    byFrame.get(frameId).push({ id, value: d.value, values: d.values, date: d.date, gid: d.gid });
  });
  for (const [frameId, items] of byFrame) {
    let results = [];
    try {
      const [res] = await inFrames(tabId, (list) => window.__fillai?.fill(list), [items.map(({ id, value, values, date }) => ({ id, value, values, date }))], [frameId]);
      results = res?.result || [];
    } catch {
      results = [];
    }
    for (const item of items) {
      const r = results.find((x) => x.id === item.id);
      const d = decisions.find((x) => x.gid === item.gid);
      if (r?.ok) {
        if (r.shown) d.value = r.shown;
        continue;
      }
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
    byFrame.get(frameId)[id] = d.mine ? 'mine' : MARK[d.status] || '';
  }
  for (const [frameId, marks] of byFrame) {
    await inFrames(tabId, (m) => window.__fillai?.mark(m), [marks], [frameId]).catch(() => {});
  }
}

async function applyOne(port, tabId, msg) {
  const [frameId, id] = splitGid(msg.gid);
  const values = msg.values || [];
  const item = { id, value: msg.value || '', values };
  if (msg.date) item.date = msg.date;
  const [res] = await inFrames(tabId, (list) => window.__fillai?.fill(list), [[item]], [frameId]);
  const r = res?.result?.[0];
  if (!r?.ok) return post(port, { type: 'applied', gid: msg.gid, ok: false, error: r?.error || 'Could not fill this field.' });
  let saved = false;
  if (msg.save?.question) {
    // Dates are saved as YYYY-MM-DD, so the next form can write them its own way.
    const answer = msg.date || (values.length ? values.join(', ') : msg.value);
    await rememberFact({ question: msg.save.question, answer, site: siteOf(port) });
    saved = true;
  }
  await inFrames(tabId, (m) => window.__fillai?.mark(m), [{ [id]: 'fill' }], [frameId]).catch(() => {});
  post(port, { type: 'applied', gid: msg.gid, ok: true, value: r.shown || msg.value, values, saved });
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

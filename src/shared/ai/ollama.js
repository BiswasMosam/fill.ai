// Local models through Ollama (https://ollama.com). Free, and nothing leaves
// the computer. This is the default.
//
// Three things differ from the cloud AIs:
// - Local models can't read PDFs. The settings page turns a resume into text
//   before it gets here (see options/pdf-text.js).
// - Ollama answers 403 to any request whose Origin is chrome-extension://
//   unless OLLAMA_ORIGINS is set. Instead of asking every friend to set an
//   environment variable, a declarativeNetRequest rule drops that header on
//   fill.ai's own requests to the Ollama address, and nobody else's.
// - Ollama's context window defaults to a few thousand tokens and silently
//   cuts what doesn't fit, which would drop half the profile. Every request
//   sets num_ctx to fit the prompt, and refuses when it can't.

import { FillError, isAbort, lines, parseJson } from './errors.js';

export const id = 'ollama';
export const name = 'Your computer';
export const readsPdf = false;
export const DEFAULT_URL = 'http://localhost:11434';
export const RECOMMENDED = 'qwen3.5:4b';
const MAX_CTX = 65536;
const RULE_ID = 1;

export function isConnected(settings) {
  return !!settings.ollamaModel;
}

export function baseOf(url) {
  return (url || DEFAULT_URL).trim().replace(/\/+$/, '');
}

let ruleFor = null;
export async function allowOrigin(url) {
  const base = baseOf(url);
  if (ruleFor === base) return;
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    throw new FillError('bad-url', `${base} is not a web address. Ollama usually lives at ${DEFAULT_URL}.`);
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: { urlFilter: `|${origin}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
      },
    ],
  });
  ruleFor = base;
}

async function call(settings, path, { body, signal, method = body ? 'POST' : 'GET' } = {}) {
  const base = baseOf(settings.ollamaURL);
  await allowOrigin(base);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw new FillError('aborted', 'Stopped.');
    throw new FillError('offline', `Ollama isn't answering at ${base}. Start Ollama and try again.`);
  }
  if (res.status === 403) {
    throw new FillError('forbidden', 'Ollama turned fill.ai away. Set OLLAMA_ORIGINS to chrome-extension://* and restart Ollama.');
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => null))?.error || `HTTP ${res.status}`;
    if (res.status === 404 && /not found/i.test(msg)) {
      throw new FillError('no-model', `${settings.ollamaModel} isn't installed. In a terminal, run: ollama pull ${settings.ollamaModel}`);
    }
    throw new FillError('api', `Ollama: ${msg}`);
  }
  return res;
}

// What a model can do, and how much context it takes. Asked once per model.
const shown = new Map();
async function modelInfo(settings, model) {
  const key = `${baseOf(settings.ollamaURL)}|${model}`;
  if (!shown.has(key)) {
    const info = await (await call(settings, '/api/show', { body: { model } })).json();
    const ctx = Object.entries(info.model_info || {}).find(([k]) => k.endsWith('.context_length'))?.[1];
    shown.set(key, { capabilities: info.capabilities || [], contextLength: Number(ctx) || 32768 });
  }
  return shown.get(key);
}

// Smallest power of two from 8K that holds the prompt and the answer.
// Doubling steps keep Ollama from reloading the model for every form.
export function contextFor(promptChars, answerTokens, modelMax = MAX_CTX) {
  const need = Math.ceil(promptChars / 3) + answerTokens + 512;
  const cap = Math.min(MAX_CTX, modelMax);
  let ctx = 8192;
  while (ctx < need && ctx < cap) ctx *= 2;
  if (need > cap) return null;
  return Math.min(ctx, cap);
}

function flatten(content, canSee) {
  const text = [];
  const images = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type === 'image') {
      if (!canSee) throw new FillError('no-vision', "This model can't read images. Add your resume as a PDF or text, or pick a model that can see.");
      images.push(block.source.data);
    } else if (block.type === 'document') {
      throw new FillError('no-pdf', 'Local models read text, not PDF files. This PDF should have been turned into text first.');
    }
  }
  return { text: text.join('\n\n'), images };
}

// Thinking helps on the careful setting only. On a laptop GPU it can double
// the wait, so the faster settings answer straight away.
const THINK = { low: false, medium: false, high: true };

export async function askJson({ settings, system, content, schema, effort, maxTokens = 16000, onText, signal }) {
  const model = settings.ollamaModel;
  if (!model) throw new FillError('no-model', 'Choose a local model in fill.ai settings first.');
  const info = await modelInfo(settings, model);
  const { text, images } = flatten(content, info.capabilities.includes('vision'));
  const think = info.capabilities.includes('thinking') && THINK[effort || 'high'];
  const answer = Math.min(maxTokens, think ? 16384 : 8192);
  const numCtx = contextFor(system.length + text.length + JSON.stringify(schema).length, answer, info.contextLength);
  if (!numCtx) throw new FillError('too-long', 'This is more than a local model can read at once. Try one page of the form at a time.');

  const res = await call(settings, '/api/chat', {
    signal,
    body: {
      model,
      stream: true,
      think,
      format: schema,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text, ...(images.length ? { images } : {}) },
      ],
      options: { temperature: 0, num_ctx: numCtx, num_predict: answer },
    },
  });

  let out = '';
  let reason = '';
  try {
    for await (const line of lines(res)) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line);
      if (chunk.error) throw new FillError('api', `Ollama: ${chunk.error}`);
      const piece = chunk.message?.content || '';
      if (piece) {
        out += piece;
        onText?.(out);
      }
      if (chunk.done) reason = chunk.done_reason || '';
    }
  } catch (err) {
    if (err instanceof FillError) throw err;
    if (isAbort(err)) throw new FillError('aborted', 'Stopped.');
    throw new FillError('offline', 'The connection to Ollama dropped. Try again.');
  }
  if (reason === 'length') throw new FillError('too-long', 'The model ran out of room before it finished. Try one page of the form at a time.');
  return { data: parseJson(out, model), cost: null, via: `${model} on this computer` };
}

// Is Ollama up, and which chat models does it have? Embedding-only models
// can't answer forms, so they are left out.
export async function test(settings) {
  const [version, tags] = await Promise.all([
    call(settings, '/api/version').then((r) => r.json()),
    call(settings, '/api/tags').then((r) => r.json()),
  ]);
  const models = (tags.models || [])
    .filter((m) => !m.capabilities || m.capabilities.includes('completion'))
    .map((m) => ({ name: m.name, size: m.size || 0, capabilities: m.capabilities || [], params: m.details?.parameter_size || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { version: version.version || '', models };
}

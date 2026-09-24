// Gemini through Google's free API tier. Needs only a free key from AI
// Studio, so it suits a laptop without a graphics card. The catch, shown on
// the settings page: Google may use free-tier requests, resume included, to
// improve its products.
//
// Plain REST (streamGenerateContent over SSE) with a JSON schema for the
// output. Gemini reads PDFs itself, so resumes go over as they are.

import { FillError, isAbort, lines, parseJson } from './errors.js';

export const id = 'gemini';
export const name = 'Gemini';
export const readsPdf = true;
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
const API = 'https://generativelanguage.googleapis.com';

// effort -> thinking level. If a model rejects the setting, the request is
// sent again without it and that model is remembered for the session.
const LEVEL = { low: 'low', medium: 'medium', high: 'high' };
const noThinkingLevel = new Set();

export function isConnected(settings) {
  return !!settings.geminiKey;
}

function endpoint(settings, path) {
  return `${(settings.geminiBaseURL || API).replace(/\/+$/, '')}/v1beta/${path}`;
}

function modelOf(settings) {
  return (settings.geminiModel || DEFAULT_MODEL).trim();
}

function headers(settings) {
  if (!settings.geminiKey) throw new FillError('no-key', 'Add your Gemini API key in Fill.ai settings first.');
  return { 'content-type': 'application/json', 'x-goog-api-key': settings.geminiKey };
}

function toParts(content) {
  const parts = [];
  for (const block of content) {
    if (block.type === 'text') parts.push({ text: block.text });
    else if (block.type === 'document' || block.type === 'image') {
      if (block.title) parts.push({ text: `Source: ${block.title}` });
      parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
    }
  }
  return parts;
}

async function send(settings, model, body, signal) {
  let res;
  try {
    res = await fetch(endpoint(settings, `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`), {
      method: 'POST',
      headers: headers(settings),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw new FillError('aborted', 'Stopped.');
    throw new FillError('offline', 'Could not reach Gemini. Check your internet connection.');
  }
  return res;
}

export async function askJson({ settings, system, content, schema, effort, maxTokens = 32000, onText, signal }) {
  const model = modelOf(settings);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: toParts(content) }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      maxOutputTokens: maxTokens,
    },
  };
  if (!noThinkingLevel.has(model)) body.generationConfig.thinkingConfig = { thinkingLevel: LEVEL[effort] || 'high' };

  let res = await send(settings, model, body, signal);
  if (res.status === 400 && body.generationConfig.thinkingConfig) {
    const err = await errorOf(res);
    if (!/thinking/i.test(err.message)) throw toFillError(res.status, err, model);
    noThinkingLevel.add(model);
    delete body.generationConfig.thinkingConfig;
    res = await send(settings, model, body, signal);
  }
  if (!res.ok) throw toFillError(res.status, await errorOf(res), model);

  let text = '';
  let finish = '';
  try {
    for await (const line of lines(res)) {
      if (!line.startsWith('data:')) continue;
      const chunk = JSON.parse(line.slice(5));
      if (chunk.error) throw toFillError(chunk.error.code, chunk.error, model);
      if (chunk.promptFeedback?.blockReason) throw new FillError('refusal', 'Gemini declined this request. Nothing was filled.');
      const cand = chunk.candidates?.[0];
      const piece = (cand?.content?.parts || [])
        .filter((p) => !p.thought && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');
      if (piece) {
        text += piece;
        onText?.(text);
      }
      if (cand?.finishReason) finish = cand.finishReason;
    }
  } catch (err) {
    if (err instanceof FillError) throw err;
    if (isAbort(err)) throw new FillError('aborted', 'Stopped.');
    throw new FillError('offline', 'The connection to Gemini dropped. Try again.');
  }

  if (finish === 'MAX_TOKENS') throw new FillError('too-long', 'This form is too large to answer in one go. Try filling it one page at a time.');
  if (finish && finish !== 'STOP') throw new FillError('refusal', `Gemini stopped early (${finish.toLowerCase()}). Nothing was filled.`);
  return { data: parseJson(text, 'Gemini'), cost: null, via: 'Gemini free tier' };
}

// Looking the model up checks the key and the model name without spending
// any of the day's free requests.
export async function test(settings) {
  const model = modelOf(settings);
  let res;
  try {
    res = await fetch(endpoint(settings, `models/${encodeURIComponent(model)}`), { headers: headers(settings) });
  } catch {
    throw new FillError('offline', 'Could not reach Gemini. Check your internet connection.');
  }
  if (!res.ok) throw toFillError(res.status, await errorOf(res), model);
  const info = await res.json().catch(() => ({}));
  return { detail: `Connected. ${info.displayName || model} is ready.` };
}

async function errorOf(res) {
  const body = await res.json().catch(() => null);
  return body?.error || { message: `HTTP ${res.status}` };
}

function toFillError(status, err, model) {
  const msg = err?.message || '';
  if (/api key/i.test(msg) || status === 401 || err?.status === 'UNAUTHENTICATED') return new FillError('bad-key', 'Your Gemini API key was rejected. Check it in Fill.ai settings.');
  if (status === 403) return new FillError('forbidden', `This key can't use ${model}. ${msg}`.trim());
  if (status === 404) return new FillError('no-model', `Gemini has no model called ${model}. Pick another in Fill.ai settings.`);
  if (status === 429) return new FillError('rate-limit', "You've reached Gemini's free limit for now. Wait a minute, or until tomorrow if the day's requests are used up.");
  if (status === 500 || status === 503) return new FillError('busy', 'Gemini is busy right now. Try again in a minute.');
  return new FillError('api', `Gemini error ${status}: ${msg}`);
}

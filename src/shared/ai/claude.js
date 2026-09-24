// Claude Opus 5 through the Anthropic API, with the person's own key. Paid,
// and the most careful of the three.
//
// Adaptive thinking, strict JSON output. `fallbacks: "default"` lets the API
// rerun a request on Anthropic's recommended model if Opus declines it,
// instead of failing the whole form.

import Anthropic from '@anthropic-ai/sdk';
import { FillError } from './errors.js';
import { estimateCost } from '../matcher.js';

export const id = 'claude';
export const name = 'Claude';
export const readsPdf = true;
export const MODEL = 'claude-opus-5';

export function isConnected(settings) {
  return !!settings.claudeKey;
}

function makeClient({ claudeKey, claudeBaseURL }) {
  if (!claudeKey) throw new FillError('no-key', 'Add your Claude API key in Fill.ai settings first.');
  return new Anthropic({
    apiKey: claudeKey,
    baseURL: claudeBaseURL || undefined,
    dangerouslyAllowBrowser: true, // the key is the user's own and stays in this extension
    maxRetries: 2,
  });
}

// One request, one JSON object back. `onText(snapshot)` sees the JSON as it
// streams in, which is enough to show "12 of 30 answered" while Claude works.
export async function askJson({ settings, system, content, schema, effort, maxTokens = 32000, onText, signal }) {
  const client = makeClient(settings);
  let message;
  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: effort || 'high', format: { type: 'json_schema', schema } },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      },
      { signal },
    );
    if (onText) stream.on('text', (_delta, snapshot) => onText(snapshot));
    message = await stream.finalMessage();
  } catch (err) {
    throw toFillError(err);
  }

  if (message.stop_reason === 'refusal') {
    throw new FillError('refusal', 'Claude declined this request. Nothing was filled.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new FillError('too-long', 'This form is too large to answer in one go. Try filling it one page at a time.');
  }
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  try {
    return { data: JSON.parse(text), cost: estimateCost(message.usage), via: 'Claude Opus 5' };
  } catch {
    throw new FillError('bad-json', 'Claude sent back something Fill.ai could not read. Try again.');
  }
}

export async function test(settings) {
  const client = makeClient(settings);
  try {
    await client.messages.create({
      model: MODEL,
      max_tokens: 16,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    return { detail: 'Connected. Claude is ready.' };
  } catch (err) {
    throw toFillError(err);
  }
}

function toFillError(err) {
  if (err instanceof FillError) return err;
  if (err instanceof Anthropic.AuthenticationError) return new FillError('bad-key', 'Your Claude API key was rejected. Check it in Fill.ai settings.');
  if (err instanceof Anthropic.PermissionDeniedError) return new FillError('forbidden', 'This API key is not allowed to use Claude Opus 5.');
  if (err instanceof Anthropic.RateLimitError) return new FillError('rate-limit', 'Too many requests right now. Wait a moment and try again.');
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.error?.error?.message || err.message;
    if (/credit balance/i.test(msg)) return new FillError('no-credit', 'Your Anthropic account is out of credit.');
    return new FillError('bad-request', `Claude rejected the request: ${msg}`);
  }
  if (err instanceof Anthropic.APIUserAbortError) return new FillError('aborted', 'Stopped.');
  if (err instanceof Anthropic.APIConnectionError) return new FillError('offline', 'Could not reach Claude. Check your internet connection.');
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || err.status === 503) return new FillError('busy', 'Claude is busy right now. Try again in a minute.');
    return new FillError('api', `Claude API error ${err.status ?? ''}: ${err.message}`);
  }
  return new FillError('unknown', err?.message || String(err));
}

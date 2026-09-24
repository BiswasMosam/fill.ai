import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextFor } from '../../src/shared/ai/ollama.js';
import { lines, parseJson } from '../../src/shared/ai/errors.js';

test('the local context window grows in doublings to fit the prompt and the answer', () => {
  assert.equal(contextFor(3000, 4000), 8192);
  assert.equal(contextFor(30000, 8192), 32768);
  assert.equal(contextFor(60000, 16384), 65536);
});

test('the local context window never passes what the model can take', () => {
  assert.equal(contextFor(3000, 4000, 4096), null);
  assert.equal(contextFor(30000, 8192, 131072), 32768);
  assert.equal(contextFor(400000, 8192), null);
});

test('JSON wrapped in a code fence is still read', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```', 'm'), { a: 1 });
  assert.throws(() => parseJson('no json here', 'qwen'), /qwen sent back something/);
});

test('streamed lines are rebuilt across chunk boundaries', async () => {
  const chunks = ['{"a":', '1}\n{"b"', ':2}\r\n', '{"c":3}'];
  const body = new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
  const got = [];
  for await (const line of lines({ body })) got.push(line);
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

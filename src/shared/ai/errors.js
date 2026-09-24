// One error type for every AI. `code` is for the code, `message` is shown to
// the person as is, so it must say what to do next.

export class FillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 'aborted';
}

// Read a streamed response body line by line (NDJSON from Ollama, SSE from
// Gemini). A chunk can end mid-line, so partial lines wait for the next one.
export async function* lines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

// Constrained output is JSON already, but a model that ignores the schema
// sometimes wraps it in a code fence. Take the outermost object either way.
export function parseJson(text, who) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch {}
    }
    throw new FillError('bad-json', `${who} sent back something fill.ai could not read. Try again.`);
  }
}

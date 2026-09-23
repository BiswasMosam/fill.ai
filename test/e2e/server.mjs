// Test server: serves the fixture pages, and pretends to be the Claude
// Messages API so the whole extension can run end to end without a key.
//
// The fake "model" answers from simple label rules against the profile it is
// sent, the same way Claude is asked to. One rule deliberately invents an
// answer, so the tests can prove the guards throw it out.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE } from '../fixtures/profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures');
export const requests = [];

const lower = (s) => String(s || '').toLowerCase();

function pick(options, ...wanted) {
  return options.find((o) => wanted.some((w) => lower(o).includes(lower(w)))) || '';
}

function answerFor(field, profile, facts) {
  const label = lower(field.label);
  const ans = (status, value = '', sources = [], extra = {}) => ({ field_id: field.id, status, value, values: [], sources, note: '', ...extra });

  const factIndex = facts.findIndex((f) => lower(f.question) === label);
  if (factIndex !== -1) return ans('fill', facts[factIndex].answer, [`facts[${factIndex}]`]);

  const b = profile.basics;
  if (field.kind === 'file') return /resume|cv/.test(label) ? ans('fill', 'resume', ['basics.full_name']) : ans('ask');
  if (/first name/.test(label)) return ans('fill', b.first_name, ['basics.first_name']);
  if (/last name|surname/.test(label)) return ans('fill', b.last_name, ['basics.last_name']);
  if (/full name/.test(label)) return ans('fill', b.full_name, ['basics.full_name']);
  if (/e-?mail/.test(label)) return ans('fill', b.email, ['basics.email']);
  if (/phone|mobile/.test(label)) return ans('fill', b.phone, ['basics.phone']);
  if (/city/.test(label)) return ans('fill', b.location.city, ['basics.location.city']);
  if (/degree/.test(label)) return ans('fill', pick(field.options || [], 'b.tech', 'bachelor'), ['education[0].degree']);
  if (/graduation year/.test(label)) return ans('fill', profile.education[0].end.slice(0, 4), ['education[0].end'], { note: 'From your degree end date.' });
  if (/year of study/.test(label)) return ans('fill', 'Graduated', ['education[0].end'], { note: 'Your degree ended in 2026.' });
  if (/college|university/.test(label)) return ans('fill', profile.education[0].institution, ['education[0].institution']);
  if (/linkedin/.test(label)) return ans('fill', profile.links[0].url, ['links[0].url']);
  if (/github/.test(label)) return ans('fill', profile.links[1].url, ['links[1].url']);
  if (/portfolio|website/.test(label)) return ans('fill', profile.links[2].url, ['links[2].url']);
  if (/country/.test(label)) return ans('fill', b.location.country, ['basics.location.country']);
  if (/languages/.test(label)) {
    const spoken = profile.languages.map((l) => l.language);
    return ans('fill', '', ['languages'], { values: (field.options || []).filter((o) => spoken.includes(o)) });
  }
  if (/which of these have you used/.test(label)) {
    const known = profile.skills.flatMap((s) => s.items).map(lower);
    return ans('fill', '', ['skills[0].items', 'skills[1].items'], { values: (field.options || []).filter((o) => known.includes(lower(o))) });
  }
  // The invented one: the profile says nothing about Kubernetes.
  if (/kubernetes/.test(label)) return ans('fill', '3', ['experience[4].title']);
  if (/why do you want|anything else/.test(label)) {
    return ans('draft', `I build things people use. At Nimbus Labs I built a React dashboard for sensor data, and ShelfSense helps small shops predict restock dates, which is close to what Orbit does.`, ['experience[0].highlights', 'projects[0].description']);
  }
  if (/gender/.test(label)) return ans('sensitive');
  if (/agree|privacy/.test(label)) return ans('fill', 'Yes', ['basics.full_name']); // guard must still stop this
  return ans('ask', '', [], { note: 'Not in your profile.' });
}

function between(text, open, close) {
  const a = text.indexOf(open);
  const b = text.lastIndexOf(close);
  return a === -1 || b === -1 ? null : text.slice(a + open.length, b);
}

function respondStream(res, json, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'test-signature' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  const text = JSON.stringify(json);
  let i = 0;
  const tick = () => {
    if (i < text.length) {
      send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(i, i + 180) } });
      i += 180;
      setTimeout(tick, 8);
      return;
    }
    send('content_block_stop', { type: 'content_block_stop', index: 1 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  };
  setTimeout(tick, 150);
}

async function handleMessages(req, res, body) {
  const record = { headers: req.headers, body: JSON.parse(body) };
  requests.push(record);
  const payload = record.body;
  const usage = { input_tokens: 6000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  if (!payload.stream) {
    // The "Save and test" key check.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_ping', type: 'message', role: 'assistant', model: payload.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }));
    return;
  }

  const system = payload.system?.[0]?.text || '';
  if (system.startsWith("You turn a person's documents")) {
    return respondStream(res, PROFILE, usage);
  }

  const knowledge = JSON.parse(between(system, '<profile>\n', '\n</profile>'));
  const userText = payload.messages[0].content.map((c) => c.text || '').join('');
  const form = JSON.parse(between(userText, '<form>\n', '\n</form>'));
  const answers = form.fields.map((f) => answerFor(f, knowledge, knowledge.facts || []));
  respondStream(res, { answers }, usage);
}

export function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' });
      return res.end();
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handleMessages(req, res, body).catch((err) => (res.writeHead(500), res.end(String(err)))));
      return;
    }
    if (url.pathname.startsWith('/fixtures/')) {
      try {
        const file = path.join(fixtures, path.basename(url.pathname));
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end('not found');
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

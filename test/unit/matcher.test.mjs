import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFields, validateAnswers, summarize, estimateCost } from '../../src/shared/matcher.js';
import { PROFILE } from '../fixtures/profile.mjs';

const knowledge = { ...PROFILE, facts: [{ question: 'Notice period', answer: 'Immediate' }] };
const f = (gid, kind, label, extra = {}) => ({ gid, kind, label, ...extra });
const a = (field_id, status, value = '', extra = {}) => ({ field_id, status, value, values: [], sources: [], note: '', ...extra });
const run = (fields, answers, opts = {}) => validateAnswers({ fields: prepareFields(fields).fields, answers, knowledge, resumeOnFile: true, ...opts });

test('a traced answer is filled', () => {
  const [d] = run([f('0:f1', 'text', 'First name')], [a('0:f1', 'fill', 'Asha', { sources: ['basics.first_name'] })]);
  assert.equal(d.status, 'fill');
  assert.equal(d.value, 'Asha');
  assert.equal(d.sources[0].label, 'Basics · first name');
});

test('an answer with no real source becomes a question for the person', () => {
  const [d] = run([f('0:f1', 'number', 'Years of Kubernetes')], [a('0:f1', 'fill', '3', { sources: ['experience[7].title'] })]);
  assert.equal(d.status, 'ask');
  assert.equal(d.value, '');
});

test('an answer citing an empty field is rejected', () => {
  const [d] = run([f('0:f1', 'date', 'Date of birth')], [a('0:f1', 'fill', '2003-01-01', { sources: ['basics.date_of_birth'] })]);
  assert.equal(d.status, 'ask');
});

test('an email that is not in the profile is rejected even with a valid source', () => {
  const [d] = run([f('0:f1', 'email', 'Email')], [a('0:f1', 'fill', 'asha@gmail.com', { sources: ['basics.email'] })]);
  assert.equal(d.status, 'ask');
  assert.match(d.note, /email/i);
});

test('phone numbers are checked by digits, formatting may differ', () => {
  const [ok] = run([f('0:f1', 'tel', 'Mobile')], [a('0:f1', 'fill', '9876543210', { sources: ['basics.phone'] })]);
  assert.equal(ok.status, 'fill');
  const [bad] = run([f('0:f1', 'tel', 'Mobile')], [a('0:f1', 'fill', '9123456780', { sources: ['basics.phone'] })]);
  assert.equal(bad.status, 'ask');
});

test('choice answers must be one of the options, copied exactly', () => {
  const field = f('0:f1', 'select', 'Degree', { options: ['High school', 'Bachelor of Technology (B.Tech)', 'Master of Technology (M.Tech)'] });
  const [ok] = run([field], [a('0:f1', 'fill', 'bachelor of technology (b.tech)', { sources: ['education[0].degree'] })]);
  assert.equal(ok.status, 'fill');
  assert.equal(ok.value, 'Bachelor of Technology (B.Tech)');
  const [bad] = run([field], [a('0:f1', 'fill', 'PhD', { sources: ['education[0].degree'] })]);
  assert.equal(bad.status, 'ask');
});

test('multiple choice keeps only real options', () => {
  const field = f('0:f1', 'checkboxes', 'Skills', { options: ['Python', 'React', 'Go'], multiple: true });
  const [ok] = run([field], [a('0:f1', 'fill', '', { values: ['python', 'React'], sources: ['skills[0].items', 'skills[1].items'] })]);
  assert.deepEqual(ok.values, ['Python', 'React']);
  const [bad] = run([field], [a('0:f1', 'fill', '', { values: ['Python', 'Rust'], sources: ['skills[0].items'] })]);
  assert.equal(bad.status, 'ask');
});

test('gender is never auto-filled, even when the model tries', () => {
  const field = f('0:f1', 'select', 'Gender', { options: ['Female', 'Male', 'Prefer not to say'] });
  const [d] = run([field], [a('0:f1', 'fill', 'Female', { sources: ['basics.full_name'] })]);
  assert.equal(d.status, 'sensitive');
});

test('a field the model calls sensitive is not filled either', () => {
  const [d] = run([f('0:f1', 'text', "Mother's maiden name")], [a('0:f1', 'sensitive', 'Sharma', { sources: ['basics.last_name'] })]);
  assert.equal(d.status, 'sensitive');
});

test("consent boxes are always the person's call", () => {
  const field = f('0:f1', 'checkbox', 'I agree to the terms and conditions', { options: ['Yes', 'No'] });
  const [d] = run([field], [a('0:f1', 'fill', 'Yes', { sources: ['facts[0]'] })]);
  assert.equal(d.status, 'consent');
});

test('passwords, OTPs and card numbers never reach the model', () => {
  const { fields, dropped } = prepareFields([f('0:a', 'text', 'Enter OTP'), f('0:b', 'text', 'Card number'), f('0:c', 'text', 'City'), f('0:d', 'text', 'PIN code')]);
  // An Indian PIN code is a postal code, not a secret.
  assert.deepEqual(
    fields.map((x) => x.gid),
    ['0:c', '0:d'],
  );
  assert.equal(dropped, 2);
});

test('saved answers count as sources', () => {
  const [d] = run([f('0:f1', 'text', 'Notice period')], [a('0:f1', 'fill', 'Immediate', { sources: ['facts[0]'] })]);
  assert.equal(d.status, 'fill');
  assert.match(d.sources[0].label, /Saved answer/);
});

test('drafts only go into prose fields', () => {
  const [ok] = run([f('0:f1', 'textarea', 'Why us?')], [a('0:f1', 'draft', 'I like building things.', { sources: ['basics.summary'] })]);
  assert.equal(ok.status, 'draft');
  const [bad] = run([f('0:f1', 'select', 'Why us?', { options: ['A', 'B'] })], [a('0:f1', 'draft', 'I like it')]);
  assert.equal(bad.status, 'ask');
});

test('dates must match the field format', () => {
  const [d] = run([f('0:f1', 'date', 'Graduation date')], [a('0:f1', 'fill', '2026', { sources: ['education[0].end'] })]);
  assert.equal(d.status, 'ask');
});

test('a resume upload needs a saved file', () => {
  const field = f('0:f1', 'file', 'Resume/CV');
  assert.equal(run([field], [a('0:f1', 'fill', 'resume', { sources: ['basics.full_name'] })])[0].status, 'fill');
  assert.equal(run([field], [a('0:f1', 'fill', 'resume', { sources: ['basics.full_name'] })], { resumeOnFile: false })[0].status, 'ask');
});

test('an already correct value is kept, not refilled', () => {
  const [d] = run([f('0:f1', 'text', 'City', { current: 'Pune' })], [a('0:f1', 'fill', 'Pune', { sources: ['basics.location.city'] })]);
  assert.equal(d.status, 'keep');
});

test('missing answers default to asking', () => {
  const [d] = run([f('0:f1', 'text', 'City')], []);
  assert.equal(d.status, 'ask');
});

test('huge option lists are trimmed to what the profile mentions, answers still checked in full', async () => {
  const { modelView, trimOptions } = await import('../../src/shared/matcher.js');
  const { textOf } = await import('../../src/shared/paths.js');
  const schools = Array.from({ length: 3000 }, (_, i) => `University ${i}`);
  schools.splice(1234, 0, 'Example Institute of Technology', 'Asian Institute of Technology', 'Other');
  const trimmed = trimOptions(schools, textOf(PROFILE));
  assert.ok(trimmed.length <= 44, `too many: ${trimmed.length}`);
  assert.equal(trimmed[0], 'Example Institute of Technology');
  assert.ok(trimmed.includes('Other'));
  const view = modelView({ gid: '0:f1', kind: 'select', label: 'University', options: schools }, textOf(PROFILE));
  assert.match(view.options_note, /of 3003 options/);
  // Not flagged as a demographic question just because a school says "Asian".
  const { fields } = prepareFields([{ gid: '0:f1', kind: 'select', label: 'Which university did you attend?', options: schools }]);
  assert.equal(fields[0].guard, undefined);
  const [d] = validateAnswers({ fields, answers: [a('0:f1', 'fill', 'Example Institute of Technology', { sources: ['education[0].institution'] })], knowledge, resumeOnFile: false });
  assert.equal(d.status, 'fill');
});

test('summary and cost', () => {
  const s = summarize([{ status: 'fill' }, { status: 'ask' }, { status: 'consent' }, { status: 'keep' }]);
  assert.deepEqual(s, { filled: 1, ask: 1, draft: 0, yours: 1, kept: 1 });
  assert.equal(estimateCost({ input_tokens: 10000, output_tokens: 2000 }), 0.1);
});

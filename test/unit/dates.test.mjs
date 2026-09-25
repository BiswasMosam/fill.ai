import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, formatDate, formatName, fullYear, isDateField, parseDate, toISO } from '../../src/shared/dates.js';
import { learnFrom, plausible, prepareFields, shapeDate, validateAnswers } from '../../src/shared/matcher.js';
import { PROFILE } from '../fixtures/profile.mjs';

const iso = (text, order) => toISO(parseDate(text, order));

test('dates are read in every common shape', () => {
  assert.equal(iso('2004-07-20'), '2004-07-20');
  assert.equal(iso('20/07/2004'), '2004-07-20'); // 20 can only be the day
  assert.equal(iso('07/20/2004'), '2004-07-20');
  assert.equal(iso('20 July 2004'), '2004-07-20');
  assert.equal(iso('July 20th, 2004'), '2004-07-20');
  assert.equal(iso('20-Jul-2004'), '2004-07-20');
  assert.equal(iso('20.07.04', 'DMY'), '2004-07-20');
  assert.equal(iso('200704', 'DMY'), '2004-07-20');
  assert.equal(iso('20072004', 'DMY'), '2004-07-20');
});

test('an ambiguous date is refused rather than guessed', () => {
  assert.equal(parseDate('03/04/2005'), null);
  assert.equal(iso('03/04/2005', 'DMY'), '2005-04-03');
  assert.equal(iso('03/04/2005', 'MDY'), '2005-03-04');
  assert.equal(parseDate('31/02/2004', 'DMY'), null);
  assert.equal(parseDate('Immediately'), null);
});

test('two-digit years land in the right century', () => {
  const now = new Date().getFullYear() % 100;
  assert.equal(fullYear(now), 2000 + now);
  assert.equal(fullYear(98), 1998);
  assert.equal(fullYear(4), 2004);
});

test('the format a field asks for is found in placeholders, masks and labels', () => {
  assert.deepEqual(detectFormat('DD/MM/YYYY'), { order: 'DMY', sep: '/', year: 4 });
  assert.deepEqual(detectFormat('mm-dd-yy'), { order: 'MDY', sep: '-', year: 2 });
  assert.deepEqual(detectFormat('Date of birth (YYYY.MM.DD)'), { order: 'YMD', sep: '.', year: 4 });
  assert.deepEqual(detectFormat('00/00/00'), { order: 'DMY', sep: '/', year: 2 });
  assert.deepEqual(detectFormat('0000-00-00'), { order: 'YMD', sep: '-', year: 4 });
  assert.equal(detectFormat('Your full name'), null);
  assert.equal(formatName(detectFormat('99/99/9999')), 'DD/MM/YYYY');
});

test('a date is written the way the field wants it', () => {
  const d = parseDate('2004-07-20');
  assert.equal(formatDate(d, { order: 'DMY', sep: '/', year: 4 }), '20/07/2004');
  assert.equal(formatDate(d, { order: 'DMY', sep: '/', year: 2 }), '20/07/04');
  assert.equal(formatDate(d, { order: 'MDY', sep: '-', year: 4 }), '07-20-2004');
  assert.equal(formatDate(d, null), '2004-07-20');
});

test('date questions are recognised, other questions are not', () => {
  assert.ok(isDateField({ kind: 'text', label: 'Date of Birth' }));
  assert.ok(isDateField({ kind: 'text', label: 'DOB' }));
  assert.ok(isDateField({ kind: 'text', label: 'Start', format: { date: 'DD/MM/YYYY' } }));
  assert.ok(isDateField({ kind: 'date', label: 'When' }));
  assert.ok(!isDateField({ kind: 'text', label: 'Candidate name' }));
  assert.ok(!isDateField({ kind: 'text', label: 'Update your address' }));
  assert.ok(!isDateField({ kind: 'select', label: 'Date of birth', options: ['a'] }));
});

test("the model's date is reshaped for the field and kept as YYYY-MM-DD", () => {
  assert.deepEqual(shapeDate({ kind: 'text', label: 'Date of Birth', format: { date: 'DD/MM/YY' } }, '2004-07-20'), { value: '20/07/04', values: [], date: '2004-07-20' });
  assert.deepEqual(shapeDate({ kind: 'text', label: 'Date of Birth' }, '2004-07-20'), { value: '20/07/2004', values: [], date: '2004-07-20' });
  assert.deepEqual(shapeDate({ kind: 'date', label: 'Date of Birth' }, '20 July 2004'), { value: '2004-07-20', values: [], date: '2004-07-20' });
  assert.deepEqual(shapeDate({ kind: 'text', label: 'Date of Birth' }, '03/04/05'), { error: 'Needs a full date.' });
  assert.equal(shapeDate({ kind: 'text', label: 'Date available' }, 'Immediately'), null);
});

const knowledge = { ...PROFILE, facts: [{ question: 'Date of Birth', answer: '2004-07-20' }, { question: 'DOB', answer: '200704' }] };
const run = (field, answer) =>
  validateAnswers({ fields: prepareFields([field]).fields, answers: [{ field_id: field.gid, status: 'fill', values: [], note: '', ...answer }], knowledge, resumeOnFile: false })[0];

test('a date of birth must match the one on file', () => {
  const field = { gid: '0:f1', kind: 'text', label: 'Date of Birth', format: { date: 'DD/MM/YYYY' } };
  const ok = run(field, { value: '2004-07-20', sources: ['facts[0]'] });
  assert.equal(ok.status, 'fill');
  assert.equal(ok.value, '20/07/2004');
  assert.equal(ok.date, '2004-07-20');
  const wrong = run(field, { value: '2004-07-21', sources: ['facts[0]'] });
  assert.equal(wrong.status, 'ask');
  assert.match(wrong.note, /date of birth/i);
  // An old answer saved as bare digits still counts, either way round.
  assert.equal(run(field, { value: '2004-07-20', sources: ['facts[1]'] }).status, 'fill');
});

test('what the person typed is learned, within reason', () => {
  const typed = (label, current, extra = {}) => ({ gid: '0:f1', kind: 'text', label, current, mine: 'typed', ...extra });
  assert.deepEqual(learnFrom(typed('Last name', 'Verma-Rao')), { question: 'Last name', answer: 'Verma-Rao' });
  assert.deepEqual(learnFrom(typed('Date of Birth', '20/07/04')), { question: 'Date of Birth', answer: '2004-07-20' });
  assert.deepEqual(learnFrom(typed('Languages', ['Hindi', 'English'], { kind: 'checkboxes', options: ['Hindi', 'English'] })), { question: 'Languages', answer: 'Hindi, English' });
  assert.deepEqual(learnFrom(typed('Alternate phone number?', 'Yes', { kind: 'select', options: ['Yes', 'No'] })), { question: 'Alternate phone number?', answer: 'Yes' });
  // Not these:
  assert.equal(learnFrom({ ...typed('Last name', 'Verma'), mine: 'kept' }), null, 'only what they changed by hand');
  assert.equal(learnFrom(typed('Gender', 'Female', { guard: 'sensitive' })), null, 'no personal questions');
  assert.equal(learnFrom(typed('Resume', 'cv.pdf', { kind: 'file' })), null);
  assert.equal(learnFrom(typed('Other response', 'Cousin')), null, 'meaningless away from its question');
  assert.equal(learnFrom(typed('Why us?', 'x'.repeat(400), { kind: 'textarea' })), null, 'one-off prose');
  assert.equal(learnFrom(typed('LinkedIn profile url', 'Indian')), null, 'not what the label asks for');
});

test('plausibility follows the label, except for choices', () => {
  assert.ok(plausible({ kind: 'text', label: 'LinkedIn' }, 'linkedin.com/in/asha'));
  assert.ok(!plausible({ kind: 'text', label: 'LinkedIn' }, 'Indian'));
  assert.ok(!plausible({ kind: 'text', label: 'Mobile number' }, 'Pune'));
  assert.ok(plausible({ kind: 'select', label: 'Another phone number?', options: ['Yes', 'No'] }, 'Yes'));
});

test('a Mr/Ms title is a personal question; a job title is not', async () => {
  const { classifyField } = await import('../../src/shared/sensitive.js');
  assert.equal(classifyField({ label: 'Title', options: ['Mr.', 'Mrs.', 'Ms.', 'Dr.'] }), 'sensitive');
  assert.equal(classifyField({ label: 'Salutation' }), 'sensitive');
  assert.equal(classifyField({ label: 'Job title' }), null);
});

test('a bare "M/F" question is gender too', async () => {
  const { classifyField } = await import('../../src/shared/sensitive.js');
  assert.equal(classifyField({ label: 'M/F', options: ['M', 'F'] }), 'sensitive');
  assert.equal(classifyField({ label: 'Working hours M/F only' }), null);
});

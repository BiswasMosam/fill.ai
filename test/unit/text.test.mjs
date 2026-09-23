import test from 'node:test';
import assert from 'node:assert/strict';
import { matchOption, norm } from '../../src/shared/text.js';
import { resolvePath, describePath } from '../../src/shared/paths.js';
import { conform, emptyProfile } from '../../src/shared/schema.js';
import { classifyField } from '../../src/shared/sensitive.js';
import { PROFILE } from '../fixtures/profile.mjs';

test('option matching prefers exact, refuses ambiguity', () => {
  assert.equal(matchOption(['Yes', 'No'], 'yes'), 0);
  assert.equal(matchOption(['Yes', 'Yes, with sponsorship'], 'Yes'), 0);
  assert.equal(matchOption(['India', 'Indonesia'], 'Ind'), -1);
  assert.equal(matchOption(['Bachelor of Technology', 'Master of Technology'], 'Bachelor'), 0);
  assert.equal(matchOption(['A', 'B'], ''), -1);
});

test('norm strips accents and punctuation', () => {
  assert.equal(norm('  Café — Déjà-vu! '), 'cafe deja vu');
});

test('paths resolve into the profile', () => {
  assert.equal(resolvePath(PROFILE, 'education[0].institution'), 'Example Institute of Technology');
  assert.equal(resolvePath(PROFILE, 'basics.location.city'), 'Pune');
  assert.equal(resolvePath(PROFILE, 'profile.basics.email'), 'asha.verma@example.com');
  assert.equal(resolvePath(PROFILE, 'nope[3].x'), undefined);
  assert.equal(describePath(PROFILE, 'experience[0].title'), 'Experience · Nimbus Labs');
});

test('conform repairs half-formed profiles', () => {
  const fixed = conform({ basics: { full_name: 'X', junk: 1 }, education: [{ institution: 5 }], extra: true });
  assert.equal(fixed.basics.full_name, 'X');
  assert.equal(fixed.basics.junk, undefined);
  assert.equal(fixed.education[0].institution, '5');
  assert.deepEqual(fixed.education[0].highlights, []);
  assert.equal(fixed.extra, undefined);
  assert.deepEqual(Object.keys(conform(null)), Object.keys(emptyProfile()));
});

test('guards classify what they should, and not more', () => {
  assert.equal(classifyField({ label: 'Password' }), 'never');
  assert.equal(classifyField({ label: 'CVV' }), 'never');
  assert.equal(classifyField({ label: 'Gender' }), 'sensitive');
  assert.equal(classifyField({ label: 'Which best describes you?', options: ['Male', 'Female', 'Non-binary'] }), 'sensitive');
  assert.equal(classifyField({ label: 'Category', options: ['General', 'OBC', 'SC', 'ST'] }), 'sensitive');
  assert.equal(classifyField({ kind: 'checkbox', label: 'I agree to the Privacy Policy' }), 'consent');
  assert.equal(classifyField({ label: 'Job category', options: ['Engineering', 'Design'] }), null);
  assert.equal(classifyField({ label: 'Pincode' }), null);
  assert.equal(classifyField({ label: 'Email address' }), null);
  assert.equal(classifyField({ label: 'How did you hear about us?' }), null);
  // Found on a live Greenhouse form.
  assert.equal(classifyField({ kind: 'combobox', label: 'Are you Hispanic/Latino?' }), 'sensitive');
  assert.equal(classifyField({ kind: 'combobox', label: 'Agreement to Arbitrate' }), 'consent');
  assert.equal(classifyField({ kind: 'combobox', label: 'AI Policy for Application', options: ['Yes', 'No'] }), 'consent');
  assert.equal(classifyField({ kind: 'combobox', label: 'Please read the terms below', options: ['I acknowledge and agree'] }), 'consent');
  assert.equal(classifyField({ kind: 'combobox', label: 'Do you require visa sponsorship?', options: ['Yes', 'No'] }), null);
});

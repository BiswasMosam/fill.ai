// Everything fill.ai remembers lives in chrome.storage.local on this machine.
// Nothing is synced and nothing leaves the browser except the parts of the
// profile sent to Claude while a form is being filled.

import { conform, emptyProfile } from './schema.js';

export const DEFAULT_SETTINGS = {
  apiKey: '',
  effort: 'high', // low | medium | high, shown as Fast | Balanced | Careful
  baseURL: '', // empty = Anthropic. Only the test harness points this elsewhere.
};

const get = (keys) => chrome.storage.local.get(keys);
const set = (items) => chrome.storage.local.set(items);

export async function getSettings() {
  const { settings } = await get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await set({ settings: next });
  return next;
}

export async function getProfile() {
  const { profile } = await get('profile');
  return profile ? conform(profile) : emptyProfile();
}

export async function saveProfile(profile) {
  await set({ profile: conform(profile) });
}

export async function getFacts() {
  const { facts } = await get('facts');
  return Array.isArray(facts) ? facts : [];
}

export async function saveFacts(facts) {
  await set({ facts });
}

// Save (or overwrite) an answer the user typed into a form. Same question on
// the same kind of field replaces the old answer instead of piling up.
export async function rememberFact({ question, answer, site }) {
  const facts = await getFacts();
  const key = question.trim().toLowerCase();
  const existing = facts.findIndex((f) => f.question.trim().toLowerCase() === key);
  const fact = { question: question.trim(), answer, site: site || '', savedAt: new Date().toISOString() };
  if (existing === -1) facts.push(fact);
  else facts[existing] = fact;
  await saveFacts(facts);
  return facts;
}

export async function getResumeFile() {
  const { resumeFile } = await get('resumeFile');
  return resumeFile || null;
}

export async function saveResumeFile(file) {
  await set({ resumeFile: file });
}

export async function getSources() {
  const { sources } = await get('sources');
  return Array.isArray(sources) ? sources : [];
}

export async function saveSources(sources) {
  await set({ sources });
}

export async function getPanelPos() {
  const { panelPos } = await get('panelPos');
  return panelPos || null;
}

export async function savePanelPos(panelPos) {
  await set({ panelPos });
}

export async function wipeEverything() {
  await chrome.storage.local.clear();
}

// Profile + saved answers, in the shape the prompts cite from.
export async function getKnowledge() {
  const [profile, facts] = await Promise.all([getProfile(), getFacts()]);
  return { ...profile, facts: facts.map(({ question, answer }) => ({ question, answer })) };
}

// Turns Claude's answers into decisions the page can act on, and refuses to
// trust anything it can check. Pure functions: no chrome.* in here, so the
// unit tests can run it in Node.

import { classifyField } from './sensitive.js';
import { describePath, hasContent, resolvePath, textOf } from './paths.js';
import { clean, digits, matchOption, norm } from './text.js';
import { detectFormat, formatDate, isDateField, parseDate, sameDate, toISO } from './dates.js';

const TEXTUAL = new Set(['text', 'email', 'tel', 'url', 'number', 'date', 'month', 'time', 'textarea', 'richtext', 'combobox', 'dropdown']);
const PROSE = new Set(['text', 'textarea', 'richtext']);
const CHOICE = new Set(['select', 'radio', 'checkboxes', 'checkbox']);

// Attach guards and drop fields that must never reach the model.
export function prepareFields(fields) {
  const kept = [];
  let dropped = 0;
  for (const field of fields) {
    const guard = classifyField(field);
    if (guard === 'never') {
      dropped += 1;
      continue;
    }
    kept.push(guard ? { ...field, guard } : field);
  }
  return { fields: kept, dropped };
}

// What the model sees for each field. Internal bookkeeping stays out.
export function modelView(field, knowledgeText = '') {
  const view = { id: field.gid, kind: field.kind, label: field.label };
  for (const key of ['description', 'placeholder', 'section', 'options', 'current', 'format', 'guard']) {
    const v = field[key];
    if (Array.isArray(v) ? v.length : v) view[key] = v;
  }
  if (view.options) {
    const trimmed = trimOptions(view.options, knowledgeText);
    if (trimmed.length < view.options.length) {
      view.options_note = `Only the ${trimmed.length} of ${view.options.length} options closest to the profile are listed. Pick one of them or ask.`;
      view.options = trimmed;
    }
  }
  if (field.multiple) view.multiple = true;
  if (field.required) view.required = true;
  if (isDateField(field)) view.date = true;
  return view;
}

// A field the person already answered: left exactly as it is.
export function keepMine(field, remembered) {
  const values = Array.isArray(field.current) ? field.current : [];
  return {
    gid: field.gid,
    status: 'keep',
    value: values.length ? '' : textOf(field.current),
    values,
    sources: [],
    note: '',
    mine: field.mine,
    remembered: remembered || null,
  };
}

// A list of 3,000 universities would cost more than the rest of the form put
// together. Send the options that share words with the profile, plus the
// usual escape hatches. Answers are still checked against the full list.
export function trimOptions(options, knowledgeText, max = 40) {
  if (options.length <= 80) return options;
  const known = new Set(norm(knowledgeText).split(' ').filter((w) => w.length >= 4));
  const scored = options
    .map((o, i) => {
      const words = norm(o).split(' ').filter((w) => w.length >= 4);
      const hits = words.filter((w) => known.has(w)).length;
      return { o, i, score: words.length ? hits / words.length + hits * 0.2 : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .map((x) => x.o);
  const hatches = options.filter((o) => /^(other|none|not listed|not applicable|n\/a|prefer not)/i.test(o)).slice(0, 4);
  return [...new Set([...scored, ...hatches])];
}

export function validateAnswers({ fields, answers, knowledge, resumeOnFile }) {
  const byId = new Map();
  for (const a of answers || []) if (a && !byId.has(a.field_id)) byId.set(a.field_id, a);
  return fields.map((field) => decide(field, byId.get(field.gid), knowledge, resumeOnFile));
}

const RESUME_LABEL = /\b(resume|résumé|cv|curriculum vitae)\b/i;

function decide(field, answer, knowledge, resumeOnFile) {
  const base = { gid: field.gid, status: 'ask', value: '', values: [], sources: [], note: '' };
  if (!answer) return { ...base, note: 'No answer came back for this one.' };

  const note = clean(answer.note).slice(0, 160);
  const sources = (answer.sources || [])
    .filter((p) => hasContent(resolvePath(knowledge, p)))
    .map((path) => ({ path, label: describePath(knowledge, path) }));
  let status = answer.status;
  let value = clean(answer.value);
  let values = (answer.values || []).map(clean).filter(Boolean);
  if (field.kind === 'textarea' || field.kind === 'richtext') value = String(answer.value || '').trim();

  if (status === 'skip') return { ...base, status: 'skip', note };
  if (status === 'keep' && hasContent(field.current)) return { ...base, status: 'keep', value: textOf(field.current), note };

  // Guarded fields are always the person's call, whatever the model said. A
  // field the model itself calls sensitive gets the same treatment.
  const guard = field.guard || (status === 'sensitive' ? 'sensitive' : null);
  if (guard) {
    const shaped = status === 'fill' || status === 'sensitive' ? shape(field, value, values, resumeOnFile) : { error: 'none' };
    const traced = sources.length > 0 && !shaped.error;
    const out = {
      ...base,
      status: guard,
      value: traced ? shaped.value : '',
      values: traced ? shaped.values : [],
      sources: traced ? sources : [],
      note: guard === 'consent' ? 'Your call. Fill.ai never agrees to anything for you.' : 'Personal question. Fill.ai never fills these on its own.',
    };
    if (traced && shaped.date) out.date = shaped.date;
    return out;
  }

  if (status === 'keep' || status === 'ask') return { ...base, note: note || 'Needs an answer.' };

  if (status === 'draft') {
    if (!PROSE.has(field.kind) || !value) return { ...base, note: note || 'Needs an answer.' };
    const max = field.format?.maxLength;
    if (max && value.length > max) return { ...base, note: `Draft was longer than the ${max} characters allowed.` };
    return { ...base, status: 'draft', value, sources, note };
  }

  if (status !== 'fill') return { ...base, note };

  // Attaching the saved resume to a field that asks for one needs no profile
  // path: the file is the evidence. Small local models rarely cite one here.
  if (field.kind === 'file' && norm(value) === 'resume' && resumeOnFile && !sources.length && RESUME_LABEL.test(`${field.label} ${field.placeholder || ''}`)) {
    return { ...base, status: 'fill', value: 'resume', sources: [{ path: '', label: 'Your resume file' }], note };
  }

  // From here on the model claims it knows the answer. Make it prove it.
  if (!sources.length) return { ...base, note: 'Could not trace an answer to your profile.' };
  const shaped = shape(field, value, values, resumeOnFile);
  if (shaped.error) return { ...base, note: shaped.error };
  const evidence = sources.map((s) => textOf(resolvePath(knowledge, s.path))).join(' ');
  const proof = checkEvidence(field, shaped.value, evidence);
  if (proof) return { ...base, note: proof };

  if (hasContent(field.current) && same(field, field.current, shaped)) {
    return { ...base, status: 'keep', value: textOf(field.current), sources, note };
  }
  const out = { ...base, status: 'fill', value: shaped.value, values: shaped.values, sources, note };
  if (shaped.date) out.date = shaped.date;
  return out;
}

// Fit a value to what the field can accept, or explain why it can't.
function shape(field, value, values, resumeOnFile) {
  const { kind } = field;
  if (kind === 'file') {
    if (norm(value) === 'resume' && resumeOnFile) return { value: 'resume', values: [] };
    return { error: resumeOnFile ? 'Upload this one yourself.' : 'Add your resume PDF in settings to attach it here.' };
  }
  if (kind === 'checkbox') {
    const yes = /^(yes|true|checked|tick|on)$/i.test(value);
    const no = /^(no|false|unchecked|off)$/i.test(value);
    if (!yes && !no) return { error: 'Needs a yes or no.' };
    return { value: yes ? 'Yes' : 'No', values: [] };
  }
  // Custom dropdowns whose options were read from the page are choices too.
  const choice = CHOICE.has(kind) || ((kind === 'combobox' || kind === 'dropdown') && field.options?.length > 0);
  if (choice && field.multiple) {
    const picked = [];
    for (const v of values.length ? values : value ? [value] : []) {
      const i = matchOption(field.options || [], v);
      if (i === -1) return { error: `"${v}" is not one of the options.` };
      if (!picked.includes(field.options[i])) picked.push(field.options[i]);
    }
    if (!picked.length) return { error: 'No option was chosen.' };
    return { value: '', values: picked };
  }
  if (choice) {
    const i = matchOption(field.options || [], value);
    if (i === -1) return { error: value ? `"${value}" is not one of the options.` : 'No option was chosen.' };
    return { value: field.options[i], values: [] };
  }
  if (!TEXTUAL.has(kind)) return { error: 'Fill.ai cannot fill this kind of field yet.' };
  if (!value) return { error: 'Empty answer.' };
  if (isDateField(field)) {
    const dated = shapeDate(field, value);
    if (dated) return dated;
  }
  if (kind === 'month' && !/^\d{4}-\d{2}$/.test(value)) return { error: 'Needs a month and year.' };
  if (kind === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return { error: 'Needs a number.' };
  if (kind === 'url' && !/^https?:\/\//i.test(value)) return { value: `https://${value}`, values: [] };
  const max = field.format?.maxLength;
  if (max && value.length > max) return { error: `Answer is longer than the ${max} characters allowed.` };
  return { value, values: [] };
}

// Dates are kept as YYYY-MM-DD and written in whatever shape the field
// shows. Returns null for an answer that isn't a date at all ("Immediately"),
// which a text field may still take as it is.
export function shapeDate(field, value) {
  const fmt = detectFormat(field.format?.date);
  const date = parseDate(value, 'YMD') || parseDate(value, fmt?.order || '');
  if (!date) {
    if (field.kind === 'date' || /\d{1,2}[-/.]\d{1,2}|\d{6}/.test(value)) return { error: 'Needs a full date.' };
    return null;
  }
  const iso = toISO(date);
  if (field.kind === 'date') return { value: iso, values: [], date: iso };
  return { value: formatDate(date, fmt || { order: 'DMY', sep: '/', year: 4 }), values: [], date: iso };
}

// Anything in running text that could be a whole date.
const DATES_IN_TEXT = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)? [A-Za-z]{3,9},? \d{4}|[A-Za-z]{3,9} \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\b\d{6}(?:\d{2})?\b/g;

// Cheap, strict checks for the fields where a made-up answer does real harm.
function checkEvidence(field, value, evidence) {
  const label = norm(`${field.label} ${field.placeholder || ''}`);
  const isEmail = field.kind === 'email' || /\be ?mail\b/.test(label);
  if (isEmail && value.includes('@')) {
    return evidence.toLowerCase().includes(value.toLowerCase()) ? '' : 'That email is not in your profile.';
  }
  const isPhone = field.kind === 'tel' || /\b(phone|mobile|contact number|whatsapp)\b/.test(label);
  if (isPhone) {
    const d = digits(value);
    const known = digits(evidence);
    const tail = d.slice(-Math.min(10, d.length));
    if (d.length >= 6 && !known.includes(tail)) return 'That number is not in your profile.';
  }
  if (/\b(birth|dob|d o b|born)\b/.test(label)) {
    const want = parseDate(value, 'YMD') || parseDate(value, detectFormat(field.format?.date)?.order || 'DMY');
    // Any reading of a date in the evidence will do ("200704" may be either
    // way round); the digits still have to be there.
    const stated = (evidence.match(DATES_IN_TEXT) || []).flatMap((t) => ['YMD', 'DMY', 'MDY'].map((o) => parseDate(t, o)));
    if (want && !stated.some((d) => sameDate(d, want))) return 'That date of birth is not in your profile.';
  }
  return '';
}

function same(field, current, shaped) {
  if (shaped.date) {
    const fmt = detectFormat(field.format?.date);
    const cur = parseDate(textOf(current), 'YMD') || parseDate(textOf(current), fmt?.order || 'DMY');
    return sameDate(cur, parseDate(shaped.date, 'YMD'));
  }
  if (field.multiple) {
    const cur = (Array.isArray(current) ? current : [current]).map(norm).sort().join('|');
    return cur === shaped.values.map(norm).sort().join('|');
  }
  return norm(textOf(current)) === norm(shaped.value);
}

// ---------------------------------------------------------------- what the person filled

// Labels that only make sense next to their own question.
const CONTEXTUAL = /^(other|others|other response|please specify|if other.*|if yes.*|if no.*|specify|details?|answer|your answer|comments?|remarks?|unlabelled field)$/i;

// Does the answer look like the kind of thing the label asks for? A
// LinkedIn box holding "Indian" was not typed there on purpose.
export function plausible(field, value) {
  // A choice is one of the page's own options, whatever the label says
  // ("Do you want to give another phone number?" takes "Yes").
  if (field.options?.length) return true;
  const label = norm(`${field.label} ${field.placeholder || ''}`);
  const v = clean(value);
  if (field.kind === 'email' || /\be ?mail\b/.test(label)) return /@/.test(v);
  if (field.kind === 'url' || /\b(url|linkedin|github|website|portfolio|link)\b/.test(label)) return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+\S*$/i.test(v);
  if (field.kind === 'tel' || /\b(phone|mobile|contact number|whatsapp)\b/.test(label)) return digits(v).length >= 6;
  if (/\b(birth|dob|born)\b/.test(label)) return /\d/.test(v);
  return true;
}

// Turn what the person put in a field by hand into a saved answer, or null
// when it shouldn't become one: private questions, uploads, and one-off
// prose written for this form. Only answers they changed themselves
// ('typed'), never what the page or an old draft put there.
export function learnFrom(field) {
  if (field.mine !== 'typed' || field.guard || field.kind === 'file') return null;
  const question = clean(field.label);
  if (question.length < 2 || CONTEXTUAL.test(question)) return null;
  let answer = Array.isArray(field.current) ? field.current.map(clean).filter(Boolean).join(', ') : clean(field.current);
  if (!answer) return null;
  if (answer.length > (field.kind === 'textarea' || field.kind === 'richtext' ? 150 : 200)) return null;
  if (!plausible(field, answer)) return null;
  if (isDateField(field)) {
    const d = parseDate(answer, 'YMD') || parseDate(answer, detectFormat(field.format?.date)?.order || 'DMY');
    if (d) answer = toISO(d);
  }
  return { question, answer };
}

export function summarize(decisions) {
  const count = (s) => decisions.filter((d) => d.status === s).length;
  return {
    filled: count('fill'),
    ask: count('ask'),
    draft: count('draft'),
    yours: count('sensitive') + count('consent'),
    kept: count('keep') + count('skip'),
  };
}

// Opus 5 list prices (USD per million tokens), for the "about $0.07" readout.
const PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

export function estimateCost(usage) {
  if (!usage) return null;
  const cost =
    ((usage.input_tokens || 0) * PRICE.input +
      (usage.output_tokens || 0) * PRICE.output +
      (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
      (usage.cache_read_input_tokens || 0) * PRICE.cacheRead) /
    1e6;
  return Math.round(cost * 1000) / 1000;
}

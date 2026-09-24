// The shape of a Fill.ai profile. The same object is the JSON schema Claude
// must follow when it reads a resume, and the blueprint the profile editor
// renders from. User-saved answers live next to it in `facts`, never in here.

const str = { type: 'string' };
const bool = { type: 'boolean' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const list = (properties) => ({ type: 'array', items: obj(properties) });

export const PROFILE_SCHEMA = obj({
  basics: obj({
    full_name: str,
    first_name: str,
    middle_name: str,
    last_name: str,
    email: str,
    phone: str,
    headline: str,
    summary: str,
    date_of_birth: str,
    nationality: str,
    location: obj({ address: str, city: str, state: str, country: str, postal_code: str }),
  }),
  links: list({ label: str, url: str }),
  education: list({
    institution: str,
    degree: str,
    field_of_study: str,
    start: str,
    end: str,
    grade: str,
    location: str,
    highlights: strs,
  }),
  experience: list({
    company: str,
    title: str,
    employment_type: str,
    start: str,
    end: str,
    is_current: bool,
    location: str,
    highlights: strs,
  }),
  projects: list({
    name: str,
    role: str,
    start: str,
    end: str,
    link: str,
    tech: strs,
    description: str,
    highlights: strs,
  }),
  skills: list({ category: str, items: strs }),
  certifications: list({ name: str, issuer: str, date: str, link: str }),
  publications: list({ title: str, venue: str, date: str, link: str, description: str }),
  awards: list({ title: str, issuer: str, date: str, description: str }),
  leadership: list({ role: str, organization: str, start: str, end: str, description: str }),
  languages: list({ language: str, proficiency: str }),
  other: strs,
});

// Section titles for the editor and for human-readable source chips.
export const SECTION_TITLES = {
  basics: 'Basics',
  links: 'Links',
  education: 'Education',
  experience: 'Experience',
  projects: 'Projects',
  skills: 'Skills',
  certifications: 'Certifications',
  publications: 'Publications',
  awards: 'Awards',
  leadership: 'Leadership and activities',
  languages: 'Languages',
  other: 'Other',
  facts: 'Saved answers',
};

// Fields that deserve a multi-line editor.
export const LONG_TEXT = new Set(['summary', 'description', 'address']);

export function emptyFrom(schema) {
  if (schema.type === 'object') {
    const out = {};
    for (const [key, sub] of Object.entries(schema.properties)) out[key] = emptyFrom(sub);
    return out;
  }
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  return '';
}

export function emptyProfile() {
  return emptyFrom(PROFILE_SCHEMA);
}

// Bring any stored or imported object into the exact schema shape: missing
// keys are filled, unknown keys dropped, wrong types reset. Keeps the editor
// and the prompts from ever tripping over a half-formed profile.
export function conform(value, schema = PROFILE_SCHEMA) {
  if (schema.type === 'object') {
    const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [key, sub] of Object.entries(schema.properties)) out[key] = conform(src[key], sub);
    return out;
  }
  if (schema.type === 'array') {
    return Array.isArray(value) ? value.map((item) => conform(item, schema.items)) : [];
  }
  if (schema.type === 'boolean') return value === true;
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function isProfileEmpty(profile) {
  if (!profile) return true;
  const b = profile.basics || {};
  return !b.full_name && !b.email && !(profile.education || []).length && !(profile.experience || []).length;
}

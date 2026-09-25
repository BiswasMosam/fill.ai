// Code-level guards that do not depend on the model behaving.
//   never     - secrets and payment data. Not scanned, not sent, not filled.
//   sensitive - demographic and identity questions. Suggested, never auto-filled.
//   consent   - "I agree" / declarations. Always the user's own click.

const NEVER = [
  /\bpass(word|code|phrase)\b/i,
  /\b(otp|one[\s-]?time (password|code|pin))\b/i,
  /\bverification code\b/i,
  /\bcaptcha\b|\bi'?m not a robot\b/i,
  /\b(cvv|cvc|cvv2)\b/i,
  /\b(card number|credit card|debit card|card no\.?|expiry date|security code)\b/i,
  /\b(atm|upi|card) pin\b/i,
  /\b(bank account|account number|ifsc|routing number|iban|swift)\b/i,
];

const SENSITIVE = [
  /\b(gender|sex)\b/i,
  /^\s*(m\s*\/\s*f|f\s*\/\s*m)\s*$/i,
  /\bpronouns?\b/i,
  /\b(race|racial|ethnic|ethnicity|hispanic|latino|latina|latinx)\b/i,
  /\bcaste\b/i,
  /\b(reserved|social|reservation) category\b/i,
  /\bcategory\b.*\b(sc|st|obc|ews|general)\b/i,
  /\breligio(n|us)\b/i,
  /\bdisab(led|ility|ilities)\b/i,
  /\b(veteran|armed forces|military status|protected veteran)\b/i,
  /\bsexual orientation\b|\blgbt/i,
  /\bmarital status\b/i,
  /\b(salutation|honorific)\b/i,
  /\b(aadhaa?r|pan (card|number|no)|passport (number|no)|ssn|social security|national id|voter id|driving licen[cs]e (number|no))\b/i,
  /\b(criminal|convicted|conviction|felony)\b/i,
];

// Option sets that give a question away even when the label is vague.
const SENSITIVE_OPTIONS = [
  /^(male|female|non[\s-]?binary|man|woman|transgender)$/i,
  /^(sc|st|obc|ews|obc[\s-]?ncl)$/i,
  /^(hindu|muslim|christian|sikh|buddhist|jain)$/i,
  /\b(hispanic|latino|asian|african american|caucasian|two or more races)\b/i,
  // Mr / Ms / Mrs give away gender and marital status. Never guessed from a name.
  /^(mr|mrs|ms|miss|mx|master)\.?$/i,
];

const CONSENT = [
  /\b(i )?(agree|consent)\b/i,
  /\bterms (and|&) conditions\b|\bterms of (service|use)\b|\bprivacy (policy|notice)\b/i,
  /\bi (hereby )?(certify|declare|confirm|acknowledge|understand)\b/i,
  /\bdeclaration\b/i,
  /\barbitrat(e|ion)\b/i,
  /\bagreement\b/i,
  /\bpolicy\b.*\b(application|acknowledg)/i,
];

// Answers that are an agreement, whatever the question says ("I acknowledge
// and agree", "I have read and understood the policy").
const CONSENT_OPTION = /\b(i )?(agree|accept|acknowledge|consent)\b|\bi have read\b|\bi understand\b/i;

export function classifyField(field) {
  const label = [field.label, field.description, field.name, field.autocomplete].filter(Boolean).join(' ');
  if (NEVER.some((re) => re.test(label))) return 'never';
  if (/^cc-|one-time-code|new-password|current-password/.test(field.autocomplete || '')) return 'never';
  if (SENSITIVE.some((re) => re.test(label))) return 'sensitive';
  const options = field.options || [];
  // Demographic questions have a handful of options. A 3,000-school list
  // that contains "Asian Institute of Technology" is not one.
  const hits = options.length <= 12 ? options.filter((o) => SENSITIVE_OPTIONS.some((re) => re.test(String(o).trim()))).length : 0;
  if (hits >= 2) return 'sensitive';
  // An agreement is consent whatever widget it uses. A long multi-choice
  // question that happens to mention "privacy" is not.
  if (CONSENT.some((re) => re.test(label)) && options.length <= 4) return 'consent';
  if (options.length && options.length <= 4 && options.some((o) => CONSENT_OPTION.test(String(o)))) return 'consent';
  return null;
}

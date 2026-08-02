/**
 * Plausible decoy values.
 *
 * Noise tells an attacker they failed, so they take another screenshot. A value
 * in the right shape does not: a captured frame reading 5829-3471-9024 looks
 * like a successful capture, and nothing prompts a retry. That is the whole
 * point of this module — it trades "obviously protected" for "quietly wrong".
 *
 * The generated value always matches the source's shape exactly: same length,
 * same separators, same digit/letter/case pattern. A decoy that is visibly the
 * wrong shape is worse than noise, because it reveals the mechanism.
 */

const DIGIT = /[0-9]/;
const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;

/**
 * What a value looks like, so a decoy can be built to match.
 *
 * `kind` drives semantic generation — a fake date has to have a real month, a
 * fake card number has to pass a Luhn check — while `mask` guarantees the shape
 * is identical regardless.
 *
 * @returns {{kind:string, mask:string, digits:number, letters:number,
 *            separators:string[], describe:string}}
 */
export function detectFormat(text) {
  const s = String(text);
  const mask = [...s]
    .map((c) => (DIGIT.test(c) ? 'D' : UPPER.test(c) ? 'A' : LOWER.test(c) ? 'a' : c))
    .join('');
  const digits = (s.match(/[0-9]/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const separators = [...new Set(s.replace(/[0-9A-Za-z]/g, '').split(''))].filter(Boolean);

  let kind = 'text';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) kind = 'date-iso';
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) kind = 'date-dmy';
  else if (/^\d{2}\/\d{2}$/.test(s)) kind = 'expiry';
  else if (digits >= 13 && digits <= 19 && letters === 0) kind = 'card';
  // Grouped digits before phone: 4471-0092-8834 is an account number, and the
  // old phone pattern allowed hyphens so it swallowed anything hyphen-grouped.
  else if (/^\d+([- ]\d+)+$/.test(s)) kind = 'grouped-number';
  // A phone needs a real phone marker: a leading +, parentheses, or a leading 0.
  else if (/^(\+\d|\(|0\d)[\d ()-]{6,}$/.test(s)) kind = 'phone';
  else if (digits > 0 && letters > 0) kind = 'alphanumeric';
  else if (letters === 0 && digits > 0) kind = 'number';
  else if (/@/.test(s)) kind = 'email';

  const describe = {
    'date-iso': 'ISO date',
    'date-dmy': 'day/month/year date',
    expiry: 'card expiry',
    card: `${digits}-digit card number`,
    'grouped-number': `grouped number, ${digits} digits`,
    phone: 'phone number',
    alphanumeric: 'mixed letters and digits',
    number: `${digits}-digit number`,
    email: 'email address',
    text: 'free text',
  }[kind];

  return { kind, mask, digits, letters, separators, describe };
}

/**
 * A decoy shaped exactly like `text`.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'auto'|'number'|'text'|'random'} [opts.mode='auto']
 *   auto   — match the detected kind, semantics included
 *   number — digits everywhere a digit or letter was
 *   text   — letters everywhere a digit or letter was
 *   random — mixed, ignoring what the source looked like
 * @param {() => number} [opts.rng=Math.random]
 */
export function fakeLike(text, { mode = 'auto', rng = Math.random } = {}) {
  const s = String(text);
  if (!s) return s;
  const fmt = detectFormat(s);

  if (mode === 'auto') {
    const semantic = semanticFake(fmt, s, rng);
    if (semantic) return semantic;
  }

  const pick = (chars) => chars[Math.floor(rng() * chars.length)];
  const D = '0123456789';
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O: they read as 1/0 and look wrong
  const L = 'abcdefghijkmnopqrstuvwxyz';

  let out = '';
  for (const c of s) {
    const isDigit = DIGIT.test(c);
    const isUpper = UPPER.test(c);
    const isLower = LOWER.test(c);
    if (!isDigit && !isUpper && !isLower) {
      out += c; // separators, spaces and punctuation are structure, not content
      continue;
    }
    if (mode === 'number') out += pick(D);
    else if (mode === 'text') out += isLower ? pick(L) : pick(A);
    else if (mode === 'random') out += pick(rng() < 0.5 ? D : isLower ? L : A);
    else out += isDigit ? pick(D) : isUpper ? pick(A) : pick(L);
  }

  // A decoy identical to the original protects nothing.
  return out === s ? fakeLike(s, { mode, rng }) : out;
}

/**
 * Kind-aware generation, so a decoy survives a second look.
 *
 * A random 4-digit "month" of 8371 or a card number failing its checksum tells
 * an attacker the value is manufactured, which is worse than showing noise.
 */
function semanticFake(fmt, s, rng) {
  const n = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const pad = (v, w) => String(v).padStart(w, '0');

  switch (fmt.kind) {
    case 'date-iso':
      return `${n(2019, 2027)}-${pad(n(1, 12), 2)}-${pad(n(1, 28), 2)}`;
    case 'date-dmy':
      return `${pad(n(1, 28), 2)}/${pad(n(1, 12), 2)}/${n(2019, 2027)}`;
    case 'expiry':
      return `${pad(n(1, 12), 2)}/${pad(n(26, 31), 2)}`;
    case 'card':
      return luhnify(s, rng);
    default:
      return null;
  }
}

/**
 * Regenerate a card-shaped value whose digits satisfy the Luhn checksum, keeping
 * the original grouping. An attacker who validates the number gets a pass.
 */
function luhnify(s, rng) {
  const positions = [];
  const chars = [...s];
  chars.forEach((c, i) => DIGIT.test(c) && positions.push(i));
  if (positions.length < 13) return null;

  for (const i of positions) chars[i] = String(Math.floor(rng() * 10));
  // Solve the final digit for a valid checksum rather than rejection-sampling.
  const digits = positions.map((i) => +chars[i]);
  let sum = 0;
  for (let k = digits.length - 2; k >= 0; k--) {
    const fromRight = digits.length - 1 - k;
    let d = digits[k];
    if (fromRight % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  chars[positions[positions.length - 1]] = String((10 - (sum % 10)) % 10);
  return chars.join('');
}

/** True when every digit position satisfies the Luhn checksum. */
export function passesLuhn(text) {
  const digits = [...String(text).replace(/\D/g, '')].map(Number);
  if (digits.length < 13) return false;
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if ((digits.length - 1 - i) % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

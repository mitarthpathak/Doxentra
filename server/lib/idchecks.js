/**
 * Checks of Indian identity and tax numbers. Pure functions.
 *
 *  - Aadhaar: 12 digits, never starting with 0 or 1, last digit a Verhoeff
 *    check digit (UIDAI). The 16-digit Virtual ID (VID) uses Verhoeff too.
 *  - PAN: AAAAA9999A; the 4th letter is the holder type (P = individual,
 *    C = company, …) and the 5th the initial of the surname (individuals) or
 *    of the name (others).
 *  - GSTIN: 2-digit state code + PAN + entity number + "Z" + a mod-36 check
 *    character over the first 14 characters.
 */

// ─── Verhoeff ───────────────────────────────────────────────────────
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Whether a digit string (check digit last) passes the Verhoeff check. */
export function verhoeffValid(digits) {
  const s = String(digits);
  if (!/^\d+$/.test(s)) return false;
  let c = 0;
  const rev = s.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][rev[i]]];
  return c === 0;
}

/** The Verhoeff check digit for a digit string. */
export function verhoeffDigit(digits) {
  let c = 0;
  const rev = String(digits).split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D[c][P[(i + 1) % 8][rev[i]]];
  return INV[c];
}

// ─── Aadhaar ────────────────────────────────────────────────────────
const digitsOnly = s => String(s ?? '').replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x0966)).replace(/[\s-]/g, '');

/**
 * Look at an Aadhaar number as printed. Returns
 * { kind: 'full'|'masked'|'invalid', digits?, last4?, reason? } where reason
 * explains an invalid number (length, first digit, checksum).
 */
export function checkAadhaar(value) {
  const s = digitsOnly(value).toUpperCase();
  if (/^[X*•]{8}\d{4}$/.test(s)) return { kind: 'masked', last4: s.slice(-4) };
  if (!/^\d+$/.test(s)) return { kind: 'invalid', reason: 'format', detail: 'it should be 12 digits' };
  if (s.length !== 12) return { kind: 'invalid', reason: 'length', detail: `it has ${s.length} digits instead of 12` };
  if (/^[01]/.test(s)) return { kind: 'invalid', reason: 'first_digit', detail: 'Aadhaar numbers never start with 0 or 1' };
  if (!verhoeffValid(s)) return { kind: 'invalid', reason: 'checksum', detail: 'its last digit fails the Verhoeff checksum, so a digit was probably misread or mistyped' };
  return { kind: 'full', digits: s, last4: s.slice(-4) };
}

/** A 16-digit Virtual ID (VID), also Verhoeff-checked. */
export function checkVid(value) {
  const s = digitsOnly(value);
  if (!/^\d{16}$/.test(s)) return { valid: false, detail: 'it should be 16 digits' };
  if (!verhoeffValid(s)) return { valid: false, detail: 'its last digit fails the Verhoeff checksum' };
  return { valid: true };
}

export const maskAadhaar = value => {
  const s = digitsOnly(value);
  return /^\d{12}$/.test(s) ? `XXXX XXXX ${s.slice(-4)}` : String(value);
};

// ─── PAN ────────────────────────────────────────────────────────────
export const PAN_HOLDER_TYPES = {
  P: 'individual', C: 'company', H: 'Hindu undivided family', F: 'firm / LLP', A: 'association of persons',
  T: 'trust', B: 'body of individuals', L: 'local authority', J: 'artificial juridical person', G: 'government agency',
};

/**
 * Check a PAN: format, holder-type letter and (optionally) the name initial.
 * Returns { valid, holderType?, problems: [{ reason, detail }] }.
 */
export function checkPan(value, holderName) {
  const s = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  const problems = [];
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s)) {
    return { valid: false, problems: [{ reason: 'format', detail: 'a PAN is 5 letters, 4 digits and a letter (e.g. ABCPE1234F)' }] };
  }
  const type = s[3];
  if (!PAN_HOLDER_TYPES[type]) {
    problems.push({ reason: 'holder_type', detail: `its 4th letter "${type}" is not a valid holder type (P = individual, C = company, …)` });
  }
  // Titles and a leading "The" / "M/s" are not part of the name the PAN is based on.
  const name = String(holderName || '').replace(/(^|\s)(mr|mrs|ms|dr|shri|smt|kumari|m\/s|the)\.?\s+/gi, ' ').trim();
  const words = name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w));
  if (PAN_HOLDER_TYPES[type] && words.length) {
    // Individuals: the surname's initial; others: the first letter of the name.
    const expected = (type === 'P' ? words[words.length - 1] : words[0])[0].toUpperCase();
    if (s[4] !== expected) {
      problems.push({ reason: 'name_initial', detail: `its 5th letter "${s[4]}" should be "${expected}", the initial of the ${type === 'P' ? 'surname' : 'name'} (${type === 'P' ? words[words.length - 1] : words[0]})` });
    }
  }
  return { valid: !problems.length, holderType: PAN_HOLDER_TYPES[type] || null, problems };
}

// ─── GSTIN ──────────────────────────────────────────────────────────
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN check character for its first 14 characters. */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = B36.indexOf(first14[i]);
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (sum % 36)) % 36];
}

/** Whether a 15-character GSTIN's last character matches its checksum. */
export function gstinChecksumValid(gstin) {
  const s = String(gstin ?? '').toUpperCase();
  return /^[0-9A-Z]{15}$/.test(s) && gstinCheckChar(s.slice(0, 14)) === s[14];
}

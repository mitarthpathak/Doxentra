/**
 * Normalisation of extracted values: dates to ISO, amounts to numbers, IDs to
 * a canonical form. Written for Indian documents: DD/MM/YYYY dates, ₹ / Rs.
 * amounts with lakh grouping (1,00,000), Devanagari digits, PAN / GSTIN /
 * PIN code formats. Pure functions, no I/O.
 */

const DEVANAGARI_DIGITS = /[०-९]/g;
/** Replace Devanagari digits (०-९) with ASCII digits. */
export const asciiDigits = s => String(s ?? '').replace(DEVANAGARI_DIGITS, d => String(d.charCodeAt(0) - 0x0966));

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
  // Hindi month names
  'जनवरी': 1, 'फरवरी': 2, 'फ़रवरी': 2, 'मार्च': 3, 'अप्रैल': 4, 'मई': 5, 'जून': 6, 'जुलाई': 7,
  'अगस्त': 8, 'सितंबर': 9, 'सितम्बर': 9, 'अक्टूबर': 10, 'नवंबर': 11, 'नवम्बर': 11, 'दिसंबर': 12, 'दिसम्बर': 12,
};

const pad = n => String(n).padStart(2, '0');
function isoDate(y, m, d) {
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (y < 1800 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // e.g. 31/02
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse a date as written on a document and return YYYY-MM-DD, or null.
 * Numeric dates are read day-first (Indian convention) unless only the
 * month-first reading is valid (e.g. 03/25/2024).
 */
export function parseDate(input) {
  if (input == null) return null;
  const s = asciiDigits(input).trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  let m;
  // ISO: 2024-03-12 or 2024/03/12
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/))) return isoDate(+m[1], +m[2], +m[3]);
  // Numeric: 12/03/2024, 12-03-24, 12.03.2024
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    return isoDate(y, b, a) || isoDate(y, a, b);
  }
  // 12 March 2024 / 12-Mar-2024 / 12 मार्च 2024
  if ((m = s.match(/^(\d{1,2})[ -]([A-Za-zऀ-ॿ]+)\.?[ -](\d{2,4})$/))) {
    const month = MONTHS[m[2].toLowerCase()];
    return month ? isoDate(+m[3], month, +m[1]) : null;
  }
  // March 12 2024
  if ((m = s.match(/^([A-Za-z]+)\.? (\d{1,2}) (\d{4})$/))) {
    const month = MONTHS[m[1].toLowerCase()];
    return month ? isoDate(+m[3], month, +m[2]) : null;
  }
  return null;
}

/**
 * How a date is written, for validation: { iso, monthFirst, impossible }.
 * monthFirst: a numeric date that only makes sense as MM/DD (US style);
 * impossible: it looks like a date but no such calendar day exists (31/02/2024).
 */
export function describeDate(input) {
  const s = asciiDigits(input ?? '').trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1').replace(/,/g, ' ').replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    const dayFirst = isoDate(y, b, a);
    if (dayFirst) return { iso: dayFirst, monthFirst: false, impossible: false };
    const monthFirst = isoDate(y, a, b);
    return monthFirst ? { iso: monthFirst, monthFirst: true, impossible: false } : { iso: null, monthFirst: false, impossible: true };
  }
  const iso = parseDate(s);
  if (iso) return { iso, monthFirst: false, impossible: false };
  // A recognisable date shape whose day does not exist (2024-02-30, 31 February 2024).
  const looksLikeDate = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s) ||
    ((m = s.match(/^(\d{1,2})[ -]([A-Za-z\u0900-\u097F]+)\.?[ -](\d{2,4})$/)) && MONTHS[m[2].toLowerCase()]);
  return { iso: null, monthFirst: false, impossible: Boolean(looksLikeDate) };
}

/**
 * Parse a money amount: "₹ 1,18,000.00", "Rs. 500/-", "INR 2,500", "(1,200)".
 * Returns a number or null.
 */
export function parseAmount(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = asciiDigits(input).trim();
  if (!/\d/.test(s)) return null;
  // "(1,200)" and "-1,200" are negative; "Rs. 500/-" is not.
  const negative = /^\(.*\)$/.test(s) || /^-\s*(₹|rs\.?|inr)?\s*\d/i.test(s);
  s = s.replace(/₹|rs\.?|inr|rupees?|\/-|only|\(|\)/gi, '').replace(/\s+/g, '');
  const m = s.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** First number in a value such as "78.5%", "450 / 500", "8.2 CGPA". */
export function parseNumber(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const m = asciiDigits(input).replace(/,(?=\d{2,3}\b)/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export const FORMATS = {
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  gstin: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  pincode: /^[1-9][0-9]{5}$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  // Aadhaar must only ever appear masked on synthetic samples (XXXX XXXX 1234).
  aadhaar: /^(?:[X*x]{4}[X*x]{4}|\d{4}\d{4})\d{4}$/,
  email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
};

export const compactId = s => asciiDigits(s).toUpperCase().replace(/[\s-]/g, '');

/** Normalise an Indian phone number to +91XXXXXXXXXX; other numbers keep their digits. */
export function normalizePhone(input) {
  const raw = asciiDigits(input).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return (raw.startsWith('+') ? '+' : '') + digits;
}

/** Whether a phone number looks valid (Indian mobile/landline or international). */
export function isValidPhone(input) {
  const n = normalizePhone(input);
  if (!n) return false;
  if (n.startsWith('+91')) return /^\+91\d{10}$/.test(n);
  return /^\+?\d{7,15}$/.test(n);
}

const EMPTY_VALUES = new Set(['', 'null', 'none', 'n/a', 'na', 'nil', '-', '--', 'not available', 'not applicable', 'not found', 'unknown']);
/** Trimmed string value, or null when the model reported "nothing". */
export function cleanValue(v, max = 500) {
  if (v == null) return null;
  if (Array.isArray(v)) v = v.filter(x => x != null && String(x).trim()).join('; ');
  if (typeof v === 'object') return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  return EMPTY_VALUES.has(s.toLowerCase()) ? null : s;
}

/**
 * Canonical form of a value for its field type. `modelValue` is the
 * model's own normalisation, used when ours cannot parse the raw value.
 * Returns null when the value cannot be normalised.
 */
export function normalizeValue(field, value, modelValue) {
  if (value == null) return null;
  const tryBoth = fn => fn(value) ?? (modelValue != null ? fn(modelValue) : null);
  switch (field.type) {
    case 'date':
      return tryBoth(parseDate);
    case 'amount':
      return tryBoth(parseAmount);
    case 'number':
      return tryBoth(parseNumber);
    case 'email': {
      const e = String(value).trim().toLowerCase().replace(/^mailto:/, '');
      return FORMATS.email.test(e) ? e : null;
    }
    case 'phone':
      return normalizePhone(value);
    case 'id':
      return field.format ? compactId(value) : asciiDigits(value).trim().replace(/\s+/g, ' ');
    case 'enum': {
      const v = String(modelValue ?? value).trim();
      const options = field.options || [];
      const hit = options.find(o => o.toLowerCase() === v.toLowerCase())
        || options.find(o => v.toLowerCase().startsWith(o.toLowerCase()))
        || (/^(y|yes|present|signed|हाँ)$/i.test(v) && options.find(o => o === 'yes'))
        || (/^(m|male|पुरुष)$/i.test(v) && options.find(o => o === 'MALE'))
        || (/^(f|female|महिला)$/i.test(v) && options.find(o => o === 'FEMALE'))
        || (/^(₹|rs\.?|inr|rupees?)$/i.test(v) && options.find(o => o === 'INR'));
      return hit || v;
    }
    case 'list':
      return String(value).split(/\s*(?:;|\n|•|•)\s*/).map(x => x.trim()).filter(Boolean);
    default:
      return String(value).replace(/\s+/g, ' ').trim();
  }
}

/** Whether a value matches its field's declared format (true when there is nothing to check). */
export function matchesFormat(field, normalized) {
  if (normalized == null) return true;
  if (field.format && FORMATS[field.format]) return FORMATS[field.format].test(String(normalized));
  if (field.type === 'email') return FORMATS.email.test(String(normalized));
  if (field.type === 'phone') return isValidPhone(normalized);
  return true;
}

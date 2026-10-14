/**
 * Hindi (Devanagari) ↔ Latin, offline. Pure functions.
 *
 * transliterate(): readable Latin in the common Indian (Hunterian, no
 *   diacritics) style: आशा वर्मा → Asha Varma, परीक्षा → pariksha. The
 *   inherent "a" of a word's last consonant is dropped (कमल → kamal, आदर्श →
 *   adarsh) unless it ends a conjunct with र / य / व (मित्र → mitra, कार्य →
 *   karya); medial schwa is kept (सूचना → suchana).
 * phoneticKey(): a spelling-tolerant key so that a Latin query matches
 *   a Devanagari word and back ("suchna", "soochana" and सूचना agree).
 * translationsOf(): a small glossary of words common on Indian documents
 *   (परीक्षा ↔ examination …) for cross-language search without the AI.
 */

const VOWELS = {
  'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};
const MATRAS = {
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};
const CONSONANTS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  // Precomposed nukta letters.
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};
// A consonant followed by the nukta sign (decomposed form).
const NUKTA_FORMS = { 'क': 'q', 'ख': 'kh', 'ग': 'gh', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y' };
const NUKTA = '़';
const VIRAMA = '्';
const LABIALS = new Set(['प', 'फ', 'ब', 'भ', 'म']);
// A final conjunct ending in one of these keeps its "a" (mitra, karya, tattva).
const KEEP_FINAL_A = new Set(['र', 'य', 'व']);
const DEVANAGARI = /[ऀ-ॿ]/;
const WORD = /[ऀ-ॿ]+/g;

export const hasDevanagari = s => DEVANAGARI.test(String(s ?? ''));

/** One Devanagari word in Latin letters (lower case). */
function word(w) {
  const chars = [...w.normalize('NFC')];
  const out = [];
  // Index in `out` of a pending inherent "a" and whether it may be dropped at the word end.
  let pendingA = -1;
  let consonants = 0;
  let keepFinalA = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (CONSONANTS[c] || (c in NUKTA_FORMS && next === NUKTA)) {
      let latin = CONSONANTS[c];
      if (next === NUKTA) {
        latin = NUKTA_FORMS[c] || latin;
        i++;
      }
      keepFinalA = out.length > 0 && chars[i - 1] === VIRAMA && KEEP_FINAL_A.has(c);
      consonants++;
      out.push(latin);
      const following = chars[i + 1];
      if (following === VIRAMA) {
        i++;
        pendingA = -1;
      } else if (MATRAS[following]) {
        out.push(MATRAS[following]);
        i++;
        pendingA = -1;
      } else {
        out.push('a');
        pendingA = out.length - 1;
      }
    } else if (VOWELS[c]) {
      out.push(VOWELS[c]);
      pendingA = -1;
    } else if (c === 'ं' || c === 'ँ') {
      out.push(next && LABIALS.has(next) ? 'm' : 'n');
    } else if (c === 'ः') {
      out.push('h');
    } else if (/[०-९]/.test(c)) {
      out.push(String(c.charCodeAt(0) - 0x0966));
      pendingA = -1;
    } else if (c === '।' || c === '॥') {
      out.push('.');
    } else if (c === 'ॐ') {
      out.push('om');
    }
    // Other signs (nukta alone, avagraha, accents) are dropped.
  }
  // Final schwa: कमल → kamal, but मित्र → mitra and न → na.
  if (pendingA === out.length - 1 && consonants > 1 && !keepFinalA) out.pop();
  return out.join('');
}

/** Devanagari text in Latin letters; other text is kept. Words starting a sentence or name keep their case style. */
export function transliterate(text, { capitalize = false } = {}) {
  if (text == null) return text;
  const s = String(text).replace(WORD, w => word(w));
  return capitalize ? s.replace(/(^|[\s(/"'“-])([a-z])/g, (_, p, c) => p + c.toUpperCase()) : s;
}

/**
 * Spelling-tolerant key of a Latin (or transliterated) word: no aspiration,
 * no doubled letters, long vowels short, and no "a" after the first letter
 * (schwa is written or not): suchna, soochana, suchana → sucn.
 */
export function phoneticKey(token) {
  let s = (hasDevanagari(token) ? transliterate(token) : String(token)).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9]/g, '')
    .replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/f/g, 'p')
    .replace(/([bcdgjkpstr])h+/g, '$1')
    .replace(/(.)\1+/g, '$1');
  return s.length > 1 ? s[0] + s.slice(1).replace(/a/g, '') : s;
}

// Words common on Indian documents, Hindi ↔ English (single words only).
const GLOSSARY = [
  ['सूचना', 'notice'], ['परीक्षा', 'examination', 'exam'], ['वार्षिक', 'annual'], ['कार्यक्रम', 'schedule', 'programme', 'program'],
  ['विषय', 'subject'], ['दिनांक', 'date'], ['तिथि', 'date'], ['नाम', 'name'], ['पिता', 'father'], ['माता', 'mother'],
  ['जन्म', 'birth'], ['पता', 'address'], ['विद्यालय', 'school'], ['स्कूल', 'school'], ['महाविद्यालय', 'college'],
  ['विश्वविद्यालय', 'university'], ['छात्र', 'student'], ['छात्रों', 'students'], ['कक्षा', 'class'], ['अंक', 'marks'],
  ['कुल', 'total'], ['प्रतिशत', 'percentage'], ['परिणाम', 'result'], ['उत्तीर्ण', 'pass', 'passed'], ['अनुत्तीर्ण', 'fail', 'failed'],
  ['प्रमाण', 'certificate'], ['प्रमाणपत्र', 'certificate'], ['प्रधानाचार्य', 'principal'], ['शुल्क', 'fee', 'fees'],
  ['प्रवेश', 'admission', 'admit'], ['आवेदन', 'application'], ['आवेदक', 'applicant'], ['पंजीकरण', 'registration'],
  ['क्रमांक', 'number'], ['संख्या', 'number'], ['राशि', 'amount'], ['बीजक', 'invoice'], ['चालान', 'challan', 'invoice'],
  ['कर', 'tax'], ['रुपये', 'rupees'], ['हस्ताक्षर', 'signature'], ['अभिभावक', 'guardian', 'parent'], ['अभिभावकों', 'parents'],
  ['प्रवेशपत्र', 'admit'], ['सत्र', 'session'], ['रिपोर्ट', 'report'], ['निरीक्षण', 'inspection'], ['आदेश', 'order'],
  ['परिपत्र', 'circular'], ['पुरुष', 'male'], ['महिला', 'female'], ['लिंग', 'gender'],
];
const TRANSLATIONS = new Map();
for (const [hi, ...en] of GLOSSARY) {
  TRANSLATIONS.set(hi, [...new Set([...(TRANSLATIONS.get(hi) || []), ...en])]);
  for (const e of en) TRANSLATIONS.set(e, [...new Set([...(TRANSLATIONS.get(e) || []), hi])]);
}

/** Glossary translations of one lower-cased word (Hindi → English or English → Hindi). */
export const translationsOf = token => TRANSLATIONS.get(String(token).toLowerCase()) || [];

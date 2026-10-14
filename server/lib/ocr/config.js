import crypto from 'node:crypto';

const number = (value, fallback, min, max) => {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** Read per request so configuration is testable and can be changed on restart. */
export function ocrConfig(env = process.env) {
  const confidenceThreshold = number(env.OCR_CONFIDENCE_THRESHOLD, 0.80, 0, 1);
  return {
    enabled: env.OCR_CROSSCHECK_ENABLED !== '0',
    engines: [...new Set((env.OCR_ENGINES || 'tesseract,paddle').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))],
    confidenceThreshold,
    digitThreshold: Math.max(confidenceThreshold, number(env.OCR_DIGIT_CONFIDENCE_THRESHOLD, 0.95, 0, 1)),
    fuzzyThreshold: number(env.OCR_FUZZY_THRESHOLD, 0.92, 0.5, 1),
    timeoutMs: number(env.OCR_ENGINE_TIMEOUT_MS, 20_000, 100, 120_000),
    reprocess: env.OCR_REPROCESS_ENABLED !== '0',
    validation: env.OCR_VALIDATION_ENABLED !== '0',
    maxReprocessFields: Math.floor(number(env.OCR_MAX_REPROCESS_FIELDS, 8, 0, 60)),
  };
}

/** Configuration participates in the cache key, without storing credentials. */
export const ocrConfigHash = config => crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
export const digitSensitive = field => ['amount', 'number', 'date', 'id', 'phone'].includes(field.type) ||
  /account|phone|mobile|amount|total|date|number|_id$/.test(field.key) || /\d/.test(field.value || '');
export const fieldThreshold = (field, config) => digitSensitive(field) ? config.digitThreshold : config.confidenceThreshold;

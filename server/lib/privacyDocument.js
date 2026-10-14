import { redactDocument, maskerFor } from './redact.js';
import { asciiDigits } from './normalize.js';

/** Mask before persistence, including text retained by reviews and audit entries. */
export function maskPrivacyDocument(doc) {
  const mask = maskerFor([doc]).text;
  const redacted = redactDocument({ ...doc.extraction, filename: doc.filename, audit: doc.audit || [] });
  const sweep = value => typeof value === 'string'
    ? mask(asciiDigits(value))
      .replace(/\d{4}[\s_-]?\d{4}[\s_-]?\d{4}/g, v => `XXXX XXXX ${v.replace(/\D/g, '').slice(-4)}`)
      .replace(/[A-Z]{5}\d{4}[A-Z]/gi, v => v.replace(/\d/g, 'X'))
      .replace(/(?<!\d)\d{10}(?!\d)/g, v => `XXXXXX${v.slice(-4)}`)
    : Array.isArray(value) ? value.map(sweep)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sweep(v)])) : value;
  return {
    ...doc,
    filename: sweep(redacted.filename),
    extraction: sweep({ ...doc.extraction, ...redacted, rawTextByPage: doc.extraction.rawTextByPage }),
    metadata: sweep(doc.metadata),
    ...(doc.audit ? { audit: sweep(redacted.audit) } : {}),
  };
}

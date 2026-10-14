/**
 * Image quality of scans and photos. The browser measures the original image
 * before upload (src/lib/quality.ts, same thresholds); the server only trusts
 * the numbers and decides the issues itself:
 *   sharpness  < 25    image.blurry          warning
 *   brightness < 120   image.dark            warning
 *   contrast   < 70    image.low_contrast    warning
 *   long edge  < 1000  image.low_resolution  info
 * A poor image (blurry, dark or washed out) also caps the confidence of the
 * values read from it by OCR at 75 % (confidence.js).
 */

export const QUALITY_THRESHOLDS = { sharpness: 25, brightness: 120, contrast: 70, longEdge: 1000 };
export const QUALITY_CAP = 0.75;

export const QUALITY_RULES = [
  ['image.blurry', 'warning', 'quality', 'The photo or scan is out of focus, so OCR may misread characters.'],
  ['image.dark', 'warning', 'quality', 'The photo or scan is too dark.'],
  ['image.low_contrast', 'warning', 'quality', 'The text is faint against the paper (washed out or low contrast).'],
  ['image.low_resolution', 'info', 'quality', 'The image is small (long edge under 1000 px); small print may be unreadable.'],
];

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Quality problems of an image report: [{ rule, severity, message }]. */
export function qualityProblems(quality) {
  if (!quality || typeof quality !== 'object') return [];
  const t = QUALITY_THRESHOLDS;
  const [sharpness, brightness, contrast] = [num(quality.sharpness), num(quality.brightness), num(quality.contrast)];
  const longEdge = Math.max(num(quality.width) ?? Infinity, num(quality.height) ?? 0);
  const out = [];
  if (sharpness != null && sharpness < t.sharpness) {
    out.push({ rule: 'image.blurry', severity: 'warning', message: `The image looks blurry (sharpness ${Math.round(sharpness)}, should be at least ${t.sharpness}); values read from it may be wrong. Retake the photo in focus for a better result.` });
  }
  if (brightness != null && brightness < t.brightness) {
    out.push({ rule: 'image.dark', severity: 'warning', message: `The image is too dark (paper brightness ${Math.round(brightness)} of 255). Retake it in better light.` });
  }
  if (contrast != null && contrast < t.contrast) {
    out.push({ rule: 'image.low_contrast', severity: 'warning', message: `The text is faint (contrast ${Math.round(contrast)}, should be at least ${t.contrast}); some characters may be misread.` });
  }
  if (Number.isFinite(longEdge) && longEdge < t.longEdge) {
    out.push({ rule: 'image.low_resolution', severity: 'info', message: `The image is small (${Math.round(num(quality.width))}×${Math.round(num(quality.height))} px); small print may be unreadable.` });
  }
  return out;
}

/** Issues for the validation list (type 'quality', no field). */
export const qualityIssues = quality => qualityProblems(quality).map(p => ({ ...p, type: 'quality', fieldKeys: [] }));

/** Whether OCR values from this image get the lower confidence cap. */
export const isPoorImage = quality => qualityProblems(quality).some(p => p.severity === 'warning');

/** Only numbers and short strings from the browser's image-quality report. */
export function sanitizeQuality(q) {
  const out = {};
  for (const [k, v] of Object.entries(q).slice(0, 20)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string').slice(0, 10).map(x => x.slice(0, 200));
  }
  return out;
}

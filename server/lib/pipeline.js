import { overallConfidence, scoreExtraction } from './confidence.js';
import { lowConfidenceIssues, sortIssues, validateExtraction } from './validate.js';
import { calibrateClassification } from './classify.js';
import { isPoorImage, qualityIssues } from './quality.js';
import { applyFieldPolicy } from './fieldPolicy.js';

/**
 * Post-processing after the model (or rule-based) extraction:
 *  0. classification calibrated from model, keywords and required fields (classify.js);
 *  1. rule-based validation (missing, format, cross-field consistency) and
 *     the image-quality report of a scan or photo (quality.js);
 *  2. confidence scoring against the document text, using those issues;
 *  3. low-confidence issues for required fields under 0.5;
 *  4. overall document confidence.
 * ctx: { textByPage, textLayerPages, ocrUsed, quality?, now? }.
 */
export function finalizeExtraction(rawExtraction, { now, ...ctx }) {
  rawExtraction = applyFieldPolicy(rawExtraction);
  const extraction = calibrateClassification(rawExtraction, { textByPage: ctx.textByPage });
  const ruleIssues = [...validateExtraction(extraction, { now, textByPage: ctx.textByPage }), ...qualityIssues(ctx.quality)];
  const scored = scoreExtraction(extraction, { ...ctx, poorImage: isPoorImage(ctx.quality), issues: ruleIssues });
  const issues = sortIssues([...ruleIssues, ...lowConfidenceIssues(scored.fields)]);
  return { ...scored, issues, overallConfidence: overallConfidence(scored.fields, issues) };
}

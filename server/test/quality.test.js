import test from 'node:test';
import assert from 'node:assert/strict';
import { isPoorImage, qualityIssues, sanitizeQuality } from '../lib/quality.js';
import { RULES } from '../lib/validate.js';

test('quality issues come from the measured numbers, not from the verdict of the browser', () => {
  const rules = q => qualityIssues(q).map(i => i.rule);
  assert.deepEqual(rules({ width: 1600, height: 2200, sharpness: 72, brightness: 252, contrast: 111, warnings: ['blurry'] }), []);
  assert.deepEqual(rules({ width: 1600, height: 2200, sharpness: 11, brightness: 110, contrast: 50 }), ['image.blurry', 'image.dark', 'image.low_contrast']);
  assert.deepEqual(rules({ width: 700, height: 900, sharpness: 60, brightness: 250, contrast: 120 }), ['image.low_resolution']);
  assert.deepEqual(rules(null), []);
  assert.deepEqual(rules({ sharpness: 'x' }), []);
  assert.equal(isPoorImage({ width: 700, height: 900, sharpness: 60, brightness: 250, contrast: 120 }), false, 'small but clear');
  assert.equal(isPoorImage({ sharpness: 10 }), true);
  assert.ok(qualityIssues({ sharpness: 10 }).every(i => i.type === 'quality' && i.fieldKeys.length === 0));
  for (const id of ['image.blurry', 'image.dark', 'image.low_contrast', 'image.low_resolution']) assert.ok(RULES.some(r => r.id === id), id);
});

test('quality reports are sanitised', () => {
  assert.deepEqual(sanitizeQuality({ sharpness: 11.23456, note: 'x'.repeat(300), nested: { a: 1 }, warnings: ['blurry', 3] }),
    { sharpness: 11.235, note: 'x'.repeat(200), warnings: ['blurry'] });
});

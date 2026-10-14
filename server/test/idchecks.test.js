import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAN_HOLDER_TYPES, checkAadhaar, checkPan, checkVid, gstinCheckChar, gstinChecksumValid, maskAadhaar, verhoeffDigit, verhoeffValid,
} from '../lib/idchecks.js';

test('Verhoeff matches the published reference values', () => {
  assert.equal(verhoeffDigit('236'), 3);
  assert.ok(verhoeffValid('2363'));
  assert.ok(!verhoeffValid('2364'));
  assert.equal(verhoeffDigit('12345'), 1);
  assert.ok(verhoeffValid('123451'));
  // Catches every single-digit error and adjacent swap of a valid number.
  const valid = '2345678901' + '2' + verhoeffDigit('23456789012');
  assert.ok(verhoeffValid(valid.slice(0, 11) + valid[11]));
  for (let i = 0; i < 12; i++) {
    for (let d = 0; d <= 9; d++) {
      if (String(d) === valid[i]) continue;
      assert.ok(!verhoeffValid(valid.slice(0, i) + d + valid.slice(i + 1)), `digit ${i} -> ${d}`);
    }
  }
  for (let i = 0; i < 11; i++) {
    if (valid[i] === valid[i + 1]) continue;
    assert.ok(!verhoeffValid(valid.slice(0, i) + valid[i + 1] + valid[i] + valid.slice(i + 2)), `swap ${i}`);
  }
});

test('checkAadhaar: masked, full, and why a number is invalid', () => {
  assert.deepEqual(checkAadhaar('XXXX XXXX 4321'), { kind: 'masked', last4: '4321' });
  assert.equal(checkAadhaar('2345 6789 0124').kind, 'full');
  assert.equal(checkAadhaar('२३४५ ६७८९ ०१२४').kind, 'full', 'Devanagari digits');
  assert.equal(checkAadhaar('2345 6789 0125').reason, 'checksum');
  assert.equal(checkAadhaar('1345 6789 0124').reason, 'first_digit');
  assert.equal(checkAadhaar('2345 6789 012').reason, 'length');
  assert.equal(checkAadhaar('not a number').reason, 'format');
  assert.equal(maskAadhaar('2345 6789 0124'), 'XXXX XXXX 0124');
  assert.ok(!checkVid('1234').valid);
  const vid = '912345678901234';
  assert.ok(checkVid(vid + verhoeffDigit(vid)).valid);
});

test('checkPan: holder type and name initial', () => {
  assert.equal(PAN_HOLDER_TYPES.P, 'individual');
  assert.deepEqual(checkPan('ABCPV1234F', 'Asha Verma'), { valid: true, holderType: 'individual', problems: [] });
  assert.equal(checkPan('AAACE1234F', 'M/s. Example Traders Pvt Ltd').valid, true, 'M/s is ignored');
  assert.equal(checkPan('AAACE1234F', 'The Example Traders').valid, true, 'a leading "The" is ignored');
  assert.equal(checkPan('ABCPV1234F', 'Dr. Asha Verma').valid, true, 'titles are ignored');
  assert.equal(checkPan('ABCDV1234F').problems[0].reason, 'holder_type');
  assert.equal(checkPan('ABCPK1234F', 'Asha Verma').problems[0].reason, 'name_initial');
  assert.equal(checkPan('ABCPK1234F').valid, true, 'no name: nothing to compare');
  assert.equal(checkPan('ABC1234F').problems[0].reason, 'format');
});

test('GSTIN check character matches the published example', () => {
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
  assert.ok(gstinChecksumValid('27AAPFU0939F1ZV'));
  assert.ok(!gstinChecksumValid('27AAPFU0939F1ZW'));
  assert.ok(gstinChecksumValid('27AAACE1234F1Z6'), 'sample seller GSTIN');
  assert.ok(gstinChecksumValid('27AAFCS5678B1Z7'), 'sample buyer GSTIN');
  assert.ok(!gstinChecksumValid('27AAACE1234F1Z'));
});

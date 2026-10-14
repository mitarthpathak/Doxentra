import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMATS, asciiDigits, cleanValue, isValidPhone, matchesFormat, normalizePhone, normalizeValue, parseAmount, parseDate, parseNumber } from '../lib/normalize.js';

test('parseDate reads Indian day-first dates and common written forms', () => {
  assert.equal(parseDate('12/03/2024'), '2024-03-12');
  assert.equal(parseDate('12-03-24'), '2024-03-12');
  assert.equal(parseDate('05.11.2023'), '2023-11-05');
  assert.equal(parseDate('2024-03-12'), '2024-03-12');
  assert.equal(parseDate('12 March 2024'), '2024-03-12');
  assert.equal(parseDate('12th Mar, 2024'), '2024-03-12');
  assert.equal(parseDate('March 12, 2024'), '2024-03-12');
  assert.equal(parseDate('१२/०३/२०२४'), '2024-03-12', 'Devanagari digits');
  assert.equal(parseDate('12 मार्च 2024'), '2024-03-12', 'Hindi month');
  assert.equal(parseDate('03/25/2024'), '2024-03-25', 'month-first only when day-first is impossible');
  assert.equal(parseDate('31/02/2024'), null, 'impossible date');
  assert.equal(parseDate('soon'), null);
  assert.equal(parseDate(null), null);
});

test('parseAmount handles ₹, Rs., lakh grouping and /-', () => {
  assert.equal(parseAmount('₹ 1,18,000.00'), 118000);
  assert.equal(parseAmount('Rs. 500/-'), 500);
  assert.equal(parseAmount('INR 2,500'), 2500);
  assert.equal(parseAmount('(1,200.50)'), -1200.5);
  assert.equal(parseAmount('-₹300'), -300);
  assert.equal(parseAmount('Rupees Five Hundred Only'), null);
  assert.equal(parseAmount('₹ ५००'), 500);
  assert.equal(parseAmount(42), 42);
});

test('parseNumber takes the first number', () => {
  assert.equal(parseNumber('78.5%'), 78.5);
  assert.equal(parseNumber('450 / 500'), 450);
  assert.equal(parseNumber('1,234'), 1234);
  assert.equal(parseNumber('n/a'), null);
});

test('formats: PAN, GSTIN, PIN code, phone, email', () => {
  assert.ok(FORMATS.pan.test('ABCDE1234F'));
  assert.ok(!FORMATS.pan.test('ABCD1234F'));
  assert.ok(FORMATS.gstin.test('27ABCDE1234F1Z5'));
  assert.ok(!FORMATS.gstin.test('27ABCDE1234F1X5'));
  assert.ok(FORMATS.pincode.test('411001'));
  assert.ok(!FORMATS.pincode.test('011001'));
  assert.equal(normalizePhone('098765 43210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
  assert.ok(isValidPhone('9876543210'));
  assert.ok(!isValidPhone('12345'));
  assert.equal(asciiDigits('०१२३४५६७८९'), '0123456789');
});

test('cleanValue maps "nothing" answers to null', () => {
  for (const v of [null, '', ' N/A ', 'null', '-', 'Not available']) assert.equal(cleanValue(v), null);
  assert.equal(cleanValue('  Example   Traders '), 'Example Traders');
  assert.equal(cleanValue(['a', 'b']), 'a; b');
});

test('normalizeValue per field type and matchesFormat', () => {
  assert.equal(normalizeValue({ type: 'date' }, '12/03/2024'), '2024-03-12');
  assert.equal(normalizeValue({ type: 'date' }, 'twelfth of March', '2024-03-12'), '2024-03-12', 'falls back to the model value');
  assert.equal(normalizeValue({ type: 'amount' }, 'Rs. 1,180.00'), 1180);
  assert.equal(normalizeValue({ type: 'id', format: 'gstin' }, '27 abcde1234f1z5'), '27ABCDE1234F1Z5');
  assert.equal(normalizeValue({ type: 'email' }, 'Office@Example.COM'), 'office@example.com');
  assert.equal(normalizeValue({ type: 'email' }, 'not an email'), null);
  assert.equal(normalizeValue({ type: 'enum', options: ['INR', 'USD'] }, 'Rs.'), 'INR');
  assert.equal(normalizeValue({ type: 'enum', options: ['yes', 'no'] }, 'Signed'), 'yes');
  assert.deepEqual(normalizeValue({ type: 'list' }, 'Fix roof; Repaint walls'), ['Fix roof', 'Repaint walls']);
  assert.equal(normalizeValue({ type: 'string' }, null), null);

  assert.ok(matchesFormat({ type: 'id', format: 'pan' }, 'ABCDE1234F'));
  assert.ok(!matchesFormat({ type: 'id', format: 'pan' }, 'ABCDE12345'));
  assert.ok(!matchesFormat({ type: 'phone' }, '+12'));
  assert.ok(matchesFormat({ type: 'string' }, 'anything'));
});

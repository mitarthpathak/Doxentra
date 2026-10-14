import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFileType, precheckUpload, sniffType, MAX_UPLOAD_BYTES } from '../lib/files.js';
import { HEIC_HEADER, JPEG_HEADER, WEBP_HEADER, makePdf, makePng } from './helpers/files.js';

test('sniffType recognises files by magic bytes', () => {
  assert.equal(sniffType(makePdf([['hello']])), 'pdf');
  assert.equal(sniffType(makePng()), 'png');
  assert.equal(sniffType(JPEG_HEADER), 'jpeg');
  assert.equal(sniffType(WEBP_HEADER), 'webp');
  assert.equal(sniffType(HEIC_HEADER), 'heic');
  assert.equal(sniffType(Buffer.from('just some text')), null);
});

test('detectFileType trusts content, not the name or declared type', () => {
  // A PNG renamed to .pdf is still a PNG.
  assert.deepEqual(detectFileType(makePng(), { originalname: 'scan.pdf', mimetype: 'application/pdf' }),
    { type: 'png', mimeType: 'image/png', kind: 'image', label: 'PNG' });
  assert.equal(detectFileType(JPEG_HEADER, { originalname: 'photo.bin' }).mimeType, 'image/jpeg');
  assert.equal(detectFileType(makePdf([['x']]), {}).kind, 'pdf');
});

test('detectFileType rejects fake, empty, HEIC and oversized files with clear messages', () => {
  assert.throws(() => detectFileType(Buffer.from('not really a png'), { originalname: 'a.png', mimetype: 'image/png' }),
    e => e.status === 400 && /not a valid image/.test(e.message));
  assert.throws(() => detectFileType(Buffer.from('plain text'), { originalname: 'a.pdf' }),
    e => e.status === 400 && /not a valid PDF/.test(e.message));
  assert.throws(() => detectFileType(Buffer.from('hello'), { originalname: 'notes.txt' }),
    e => e.status === 400 && /PDF, PNG, JPG or WEBP/.test(e.message));
  assert.throws(() => detectFileType(HEIC_HEADER, { originalname: 'IMG_1.jpg' }), e => /HEIC/.test(e.message));
  assert.throws(() => detectFileType(Buffer.alloc(0)), e => e.status === 400);
  const big = Buffer.concat([JPEG_HEADER, Buffer.alloc(MAX_UPLOAD_BYTES)]);
  assert.throws(() => detectFileType(big), e => e.status === 413 && /4 MB/.test(e.message));
});

test('precheckUpload filters by declared type/extension before buffering', () => {
  assert.doesNotThrow(() => precheckUpload({ originalname: 'a.webp', mimetype: 'image/webp' }));
  assert.doesNotThrow(() => precheckUpload({ originalname: 'blob', mimetype: 'application/octet-stream' }));
  assert.throws(() => precheckUpload({ originalname: 'IMG.HEIC', mimetype: 'image/heic' }), /HEIC/);
  assert.throws(() => precheckUpload({ originalname: 'a.docx', mimetype: 'application/msword' }), /Unsupported/);
});

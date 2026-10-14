/**
 * File type detection for uploads. The declared mime type and the file
 * extension are only hints: the type is decided by the file's magic bytes.
 */

// Vercel rejects request bodies above ~4.5 MB, so keep uploads under that.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const SUPPORTED_TYPES = {
  pdf: { mimeType: 'application/pdf', kind: 'pdf', label: 'PDF' },
  png: { mimeType: 'image/png', kind: 'image', label: 'PNG' },
  jpeg: { mimeType: 'image/jpeg', kind: 'image', label: 'JPEG' },
  webp: { mimeType: 'image/webp', kind: 'image', label: 'WEBP' },
};

const ACCEPTED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/webp',
  // Some browsers/OSes send no or a generic type; magic bytes decide.
  'application/octet-stream', '',
]);
const ACCEPTED_EXT = /\.(pdf|png|jpe?g|webp)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

const UNSUPPORTED_MESSAGE = 'Unsupported file type. Please upload a PDF, PNG, JPG or WEBP file.';
const HEIC_MESSAGE = 'HEIC/HEIF photos are not supported. Please export the photo as JPG or PNG and upload it again.';

function httpError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

const ascii = (buf, start, end) => buf.subarray(start, end).toString('latin1');

/** Identify the file from its first bytes; returns a SUPPORTED_TYPES key, 'heic' or null. */
export function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  // PDF: "%PDF" near the start (some generators prepend a few junk bytes).
  if (buffer.subarray(0, 1024).includes('%PDF')) return 'pdf';
  if (buffer.length >= 8 && buffer[0] === 0x89 && ascii(buffer, 1, 4) === 'PNG' && buffer[4] === 0x0d && buffer[5] === 0x0a) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(buffer, 8, 12))) return 'heic';
  return null;
}

/**
 * Cheap pre-check used by multer before the body is buffered: rejects files
 * whose declared type and extension are both clearly unsupported.
 */
export function precheckUpload(file) {
  const name = file?.originalname || '';
  if (HEIC_EXT.test(name) || /image\/hei[cf]/i.test(file?.mimetype || '')) throw httpError(HEIC_MESSAGE, 400, 'HEIC');
  if (!ACCEPTED_MIME.has(String(file?.mimetype || '').toLowerCase()) && !ACCEPTED_EXT.test(name)) {
    throw httpError(UNSUPPORTED_MESSAGE, 400, 'UNSUPPORTED_TYPE');
  }
}

/**
 * Validate an uploaded file by its content. Returns
 * { type, kind: 'pdf'|'image', mimeType } or throws an error with an HTTP status.
 */
export function detectFileType(buffer, { mimetype = '', originalname = '' } = {}, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  if (!buffer?.length) throw httpError('The file is empty.', 400, 'EMPTY');
  if (buffer.length > maxBytes) {
    throw httpError(`File is too large. Maximum size is ${maxBytes / 1024 / 1024} MB.`, 413, 'TOO_LARGE');
  }
  const type = sniffType(buffer);
  if (type === 'heic') throw httpError(HEIC_MESSAGE, 400, 'HEIC');
  if (!type) {
    const claimed = /\.pdf$/i.test(originalname) || mimetype === 'application/pdf' ? 'PDF'
      : ACCEPTED_EXT.test(originalname) || /^image\//.test(mimetype) ? 'image' : null;
    throw httpError(claimed ? `This file is not a valid ${claimed}.` : UNSUPPORTED_MESSAGE, 400, 'BAD_CONTENT');
  }
  return { type, ...SUPPORTED_TYPES[type] };
}

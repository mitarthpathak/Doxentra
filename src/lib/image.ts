/**
 * Client-side image downscaling so phone photos and large scans fit under the
 * server's 4 MB upload limit while staying readable for OCR.
 */

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_EDGE_PX = 2000;
// Images this small are sent untouched (best OCR quality, stable cache hash).
const COMPRESS_ABOVE_BYTES = 1.5 * 1024 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.55];

export const isImageFile = (file: File) => /^image\/(png|jpe?g|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
export const isHeicFile = (file: File) => /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));

/**
 * Returns the file unchanged when it is small enough, otherwise a JPEG
 * re-encode with the long edge capped at ~2000 px.
 */
export async function prepareImage(file: File): Promise<File> {
  if (!isImageFile(file)) return file;
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error(`"${file.name}" could not be read as an image.`);
  }
  try {
    const { width, height } = decoded;
    if (file.size <= COMPRESS_ABOVE_BYTES && Math.max(width, height) <= MAX_EDGE_PX * 1.5) return file;

    const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // JPEG has no alpha: paint transparent areas white instead of black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

    for (const quality of QUALITIES) {
      const blob = await toBlob(canvas, quality);
      if (blob && blob.size <= MAX_UPLOAD_BYTES) {
        const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
        return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
      }
    }
    return file; // still too large; the size check reports it
  } finally {
    decoded.close();
  }
}

/**
 * Image quality of a scan or photo, measured in the browser before upload
 * (the original file, before any downscaling). The server turns the report
 * into "Image quality" issues (server/lib/quality.js, same thresholds).
 *
 * On a grayscale copy whose long edge is at most 1000 px (a document is
 * mostly paper, so brightness and contrast come from percentiles, not means):
 *   sharpness  variance of the Laplacian of a 3×3-averaged copy blurry below 25
 *              (the averaging removes sensor / JPEG noise, which would look sharp)
 *   brightness the paper: 90th percentile gray level (0–255)   dark below 120
 *   contrast   paper (98th) minus ink (1st percentile)         washed out below 70
 * and the original size: low resolution when the long edge is under 1000 px.
 */

export const QUALITY_THRESHOLDS = { sharpness: 25, brightness: 120, contrast: 70, longEdge: 1000 };
const ANALYSIS_EDGE = 1000;

export type QualityWarning = 'blurry' | 'dark' | 'low_contrast' | 'low_resolution';

export interface ImageQuality {
  width: number;
  height: number;
  sharpness: number;
  brightness: number;
  contrast: number;
  warnings: QualityWarning[];
}

export const QUALITY_TEXT: Record<QualityWarning, string> = {
  blurry: 'Blurry photo',
  dark: 'Too dark',
  low_contrast: 'Washed out / low contrast',
  low_resolution: 'Low resolution',
};

/** Metrics of grayscale pixels (0–255, row-major). */
export function measureGray(gray: Float32Array, width: number, height: number) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  const percentile = (p: number) => {
    const target = p * gray.length;
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += histogram[v];
      if (seen >= target) return v;
    }
    return 255;
  };
  const brightness = percentile(0.9);
  const contrast = percentile(0.98) - percentile(0.01);
  // 3×3 average, then the 4-neighbour Laplacian over the inner pixels.
  const box = new Float32Array(gray.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let t = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) t += gray[(y + dy) * width + x + dx];
      box[y * width + x] = t / 9;
    }
  }
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      const l = box[i - 1] + box[i + 1] + box[i - width] + box[i + width] - 4 * box[i];
      lapSum += l;
      lapSq += l * l;
      n++;
    }
  }
  const mean = n ? lapSum / n : 0;
  const sharpness = n ? lapSq / n - mean * mean : 0;
  return { sharpness, brightness, contrast };
}

export function qualityWarnings(q: Omit<ImageQuality, 'warnings'>): QualityWarning[] {
  const t = QUALITY_THRESHOLDS;
  const out: QualityWarning[] = [];
  if (q.sharpness < t.sharpness) out.push('blurry');
  if (q.brightness < t.brightness) out.push('dark');
  if (q.contrast < t.contrast) out.push('low_contrast');
  if (Math.max(q.width, q.height) < t.longEdge) out.push('low_resolution');
  return out;
}

/** Quality report of an image file, or null when it cannot be measured (not an image, no canvas). */
export async function measureImageQuality(file: Blob): Promise<ImageQuality | null> {
  if (!/^image\//.test(file.type)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, ANALYSIS_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(3, Math.round(bitmap.width * scale));
    const h = Math.max(3, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    const m = measureGray(gray, w, h);
    const report = {
      width: bitmap.width,
      height: bitmap.height,
      sharpness: Math.round(m.sharpness),
      brightness: Math.round(m.brightness),
      contrast: Math.round(m.contrast),
    };
    return { ...report, warnings: qualityWarnings(report) };
  } finally {
    bitmap.close();
  }
}

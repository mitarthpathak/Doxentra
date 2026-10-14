import { createCanvas, loadImage } from '@napi-rs/canvas';

/** Crop + upscale + grayscale + median denoise + Otsu binarisation, in memory.
 * Keep the original normalised region so re-reads retain source coordinates.
 */
export async function preprocessRegion(image, box) {
  const source = await loadImage(image.data);
  const region = box?.length === 4 ? box : [0, 0, 1000, 1000];
  const pad = 8;
  const x = Math.max(0, Math.floor(region[1] / 1000 * source.width) - pad);
  const y = Math.max(0, Math.floor(region[0] / 1000 * source.height) - pad);
  const width = Math.max(1, Math.min(source.width - x, Math.ceil((region[3] - region[1]) / 1000 * source.width) + pad * 2));
  const height = Math.max(1, Math.min(source.height - y, Math.ceil((region[2] - region[0]) / 1000 * source.height) + pad * 2));
  const scale = Math.min(3, 2400 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
  const canvas = createCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(pixels.data[i * 4] * 0.299 + pixels.data[i * 4 + 1] * 0.587 + pixels.data[i * 4 + 2] * 0.114);
  const filtered = gray.slice();
  for (let row = 1; row < canvas.height - 1; row++) for (let col = 1; col < canvas.width - 1; col++) {
    const neighbors = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) neighbors.push(gray[(row + dy) * canvas.width + col + dx]);
    filtered[row * canvas.width + col] = neighbors.sort((a, b) => a - b)[4];
  }
  const histogram = Array(256).fill(0);
  for (const n of filtered) histogram[n]++;
  const sum = histogram.reduce((total, count, n) => total + count * n, 0);
  let weight = 0; let partial = 0; let best = -1; let threshold = 127;
  for (let n = 0; n < 256; n++) {
    weight += histogram[n]; partial += histogram[n] * n;
    const remaining = filtered.length - weight;
    if (!weight || !remaining) continue;
    const variance = weight * remaining * (partial / weight - (sum - partial) / remaining) ** 2;
    if (variance > best) { best = variance; threshold = n; }
  }
  for (let i = 0; i < filtered.length; i++) {
    const value = filtered[i] > threshold ? 255 : 0;
    pixels.data[i * 4] = value; pixels.data[i * 4 + 1] = value; pixels.data[i * 4 + 2] = value; pixels.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return { data: canvas.toBuffer('image/png'), mimeType: 'image/png',
    region: [y / source.height * 1000, x / source.width * 1000, (y + height) / source.height * 1000, (x + width) / source.width * 1000].map(Math.round),
    steps: ['crop', 'upscale', 'grayscale', 'median_denoise', 'otsu_binarise'] };
}

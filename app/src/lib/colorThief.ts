/** Tiny dominant-color extractor.
 *
 * Decodes a base64 JPEG (or any image src) into a small offscreen canvas,
 * samples every pixel, buckets RGB into a coarse 4-bit-per-channel grid,
 * and returns the top-N most populous bucket centers.
 *
 * Skips near-grayscale and near-black/white pixels so the output reflects
 * the image's actual chroma — matters for album covers with big black bars
 * or paper-white backgrounds.
 */
const SAMPLE_SIZE = 64;
const QUANT_BITS = 4; // 4 bits per channel → 4096 buckets

export interface DominantColor {
  r: number;
  g: number;
  b: number;
  count: number;
}

export async function extractDominantColors(src: string, topN = 3): Promise<DominantColor[]> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;

  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  const shift = 8 - QUANT_BITS;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 200) continue;

    // Skip extremely dark, extremely bright, or near-grayscale pixels —
    // they make for muddy backgrounds.
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 30 || min > 230) continue;
    if (max - min < 20) continue;

    const key = ((r >> shift) << (QUANT_BITS * 2)) | ((g >> shift) << QUANT_BITS) | (b >> shift);
    const entry = buckets.get(key);
    if (entry) {
      entry.r += r;
      entry.g += g;
      entry.b += b;
      entry.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
  return sorted.slice(0, topN).map((e) => ({
    r: Math.round(e.r / e.count),
    g: Math.round(e.g / e.count),
    b: Math.round(e.b / e.count),
    count: e.count,
  }));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

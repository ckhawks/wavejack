import type { RGB } from "./types";

/** Scale a color so its brightest channel hits 255, preserving hue — turns a
 * dark/muted album color into a vivid one while keeping it recognizably *that*
 * color. Used to make album-derived palettes pop over black backgrounds. */
export function vivify(c: RGB): RGB {
  const m = Math.max(c.r, c.g, c.b, 1);
  const k = 255 / m;
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

/**
 * Sample a looping gradient through the palette. `phase` (any real number) wraps
 * into [0,1) and blends between adjacent palette entries, so sweeping phase over
 * time/space cycles smoothly through the album's colors and never leaves the
 * album's gamut (every result is a blend of two palette colors).
 */
export function samplePalette(pal: RGB[], phase: number): RGB {
  const n = pal.length;
  if (n === 1) return pal[0];
  const p = ((phase % 1) + 1) % 1;
  const f = p * n;
  const i = Math.floor(f);
  const t = f - i;
  const a = pal[i % n];
  const b = pal[(i + 1) % n];
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

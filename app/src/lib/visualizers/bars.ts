import type { Visualizer, VizFrame } from "./types";

/**
 * Classic media-player spectrum: mirrored vertical bars rising from a center
 * line, each topped with a "peak cap" that snaps up and falls slowly — the
 * Windows Media Player / Vista "Bars" look. Bars are tinted across the cover's
 * palette and glow softly so it reads as art rather than a debug meter.
 */
export function createBars(): Visualizer {
  let peaks: Float32Array | null = null;

  return {
    draw({ ctx, width, height, bins, palette }: VizFrame) {
      const n = bins.length;
      if (!peaks || peaks.length !== n) peaks = new Float32Array(n);

      ctx.clearRect(0, 0, width, height);

      const gap = Math.max(2, (width / n) * 0.22);
      const barW = (width - gap * (n - 1)) / n;
      const mid = height * 0.5;
      const maxH = height * 0.44;

      ctx.save();
      ctx.shadowBlur = Math.min(24, width / 60);
      for (let i = 0; i < n; i++) {
        const v = bins[i];
        // Peak cap: jump to the value instantly, then ease down.
        if (v >= peaks[i]) peaks[i] = v;
        else peaks[i] = Math.max(v, peaks[i] - 0.014);

        const h = Math.max(2, v * maxH);
        const x = i * (barW + gap);
        const c = palette[i % palette.length];
        ctx.shadowColor = `rgba(${c.r},${c.g},${c.b},0.6)`;

        const grad = ctx.createLinearGradient(0, mid - h, 0, mid + h);
        grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0.95)`);
        grad.addColorStop(0.5, `rgba(${c.r},${c.g},${c.b},0.55)`);
        grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0.95)`);
        ctx.fillStyle = grad;
        // Mirror around the midline for symmetry.
        ctx.fillRect(x, mid - h, barW, h * 2);

        // Bright peak caps that hang in the air as the bar drops.
        const ph = peaks[i] * maxH;
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(x, mid - ph - 3, barW, 2);
        ctx.fillRect(x, mid + ph + 1, barW, 2);
      }
      ctx.restore();
    },
  };
}

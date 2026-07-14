import type { Visualizer, VizFrame } from "./types";

/**
 * Circular spectrum: the bands wrap around a ring that breathes with the bass,
 * mirrored across the vertical axis so it stays symmetric, slowly rotating with
 * a soft bass glow behind it. Motion trails come from fading the previous frame
 * rather than hard-clearing. Vista "Alchemy"-adjacent.
 */
export function createRadial(): Visualizer {
  return {
    draw({ ctx, width, height, bins, level, palette, time }: VizFrame) {
      // Fade prior frame → trails.
      ctx.fillStyle = "rgba(0,0,0,0.20)";
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const n = bins.length;
      const minDim = Math.min(width, height);
      // Sit the ring OUTSIDE the centered album art (~0.25·height half-size in
      // the immersive view) so it reads as a reactive halo around the cover
      // rather than a disc hidden behind it.
      const baseR = minDim * (0.3 + level * 0.05);
      const c0 = palette[0];
      const c1 = palette[Math.min(1, palette.length - 1)];

      // Bass glow bloom behind the ring.
      const glow = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * (1.7 + level));
      glow.addColorStop(0, `rgba(${c0.r},${c0.g},${c0.b},${0.16 + level * 0.32})`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      // Build a closed ring from 2n segments (bands mirrored around the axis).
      const segs = n * 2;
      const rot = time * 0.06;
      ctx.beginPath();
      for (let s = 0; s <= segs; s++) {
        // Walk band 0→n-1 over the first half, then back n-1→0 over the second,
        // so the ring is symmetric across the vertical axis with no seam.
        const i = Math.min(n - 1, s < n ? s : segs - s);
        const v = bins[i];
        const ang = (s / segs) * Math.PI * 2 - Math.PI / 2 + rot;
        const r = baseR + v * minDim * 0.16;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      const stroke = ctx.createLinearGradient(0, cy - baseR, 0, cy + baseR);
      stroke.addColorStop(0, `rgb(${c0.r},${c0.g},${c0.b})`);
      stroke.addColorStop(1, `rgb(${c1.r},${c1.g},${c1.b})`);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(2, minDim / 320);
      ctx.lineJoin = "round";
      ctx.shadowBlur = 18;
      ctx.shadowColor = `rgba(${c0.r},${c0.g},${c0.b},0.8)`;
      ctx.stroke();
      ctx.shadowBlur = 0;
    },
  };
}

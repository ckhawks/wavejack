import type { Visualizer, VizFrame } from "./types";
import { vivify, samplePalette } from "./color";

/**
 * Acid trip: full-frame video feedback (draw the previous frame back onto
 * itself slightly zoomed and rotated → an endlessly melting tunnel) with a
 * kaleidoscope mandala of spectrum-reactive blobs injected each frame. Bass
 * pulses the zoom and lights a central core; the feedback smears everything
 * into spiraling fractal trails.
 *
 * Colors are drawn from the album art palette (brightened), sweeping through
 * the album's colors along each arm and slowly over time.
 *
 * The feedback pass runs in device pixels with an identity transform, so it
 * keeps its own offscreen buffer and reads the canvas' backing-store size
 * directly rather than the DPR-scaled CSS coordinates the rest of the frame
 * uses.
 */
export function createAcid(): Visualizer {
  let buf: HTMLCanvasElement | null = null;
  let bctx: CanvasRenderingContext2D | null = null;

  return {
    draw({ ctx, width, height, bins, level, time, palette }: VizFrame) {
      const pal = (palette.length ? palette : [{ r: 255, g: 60, b: 200 }]).map(vivify);
      const cv = ctx.canvas;
      const dw = cv.width;
      const dh = cv.height;
      const dpr = width > 0 ? dw / width : 1;

      // (Re)allocate the feedback buffer at backing-store resolution.
      if (!buf || buf.width !== dw || buf.height !== dh) {
        buf = document.createElement("canvas");
        buf.width = dw;
        buf.height = dh;
        bctx = buf.getContext("2d");
        if (bctx) {
          bctx.fillStyle = "#000";
          bctx.fillRect(0, 0, dw, dh);
        }
      }
      if (!bctx) return;

      // 1. Snapshot the frame we're about to build on top of.
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, dw, dh);
      bctx.drawImage(cv, 0, 0);

      // 2. Blit the snapshot back, zoomed + rotated → the tunnel. No hue-rotate:
      // rotating hue every frame would drag the trails off the album palette
      // into a generic rainbow. Keeping persistence < 1 also stops the trails
      // from accumulating to white.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Lush video feedback: redraw the previous frame back over itself (no
      // clear/fade), zoomed + rotated. The self-blend keeps the melting,
      // continuously-filling smear it starts with — content builds up and
      // spreads outward rather than being cleared, which is the look worth
      // keeping. Persistence < 1 stops it accumulating to white.
      ctx.globalAlpha = 0.84;
      const zoom = 1.01 + level * 0.03;
      // Swirl direction slowly oscillates (sine), so the arms wind one way, slow
      // to a stop, then unwind and sweep back the other way — the tunnel rocks
      // back and forth instead of spinning forever. Bass deepens the sweep.
      const rot = Math.sin(time * 0.3) * (0.008 + level * 0.022);
      ctx.translate(dw / 2, dh / 2);
      ctx.rotate(rot);
      ctx.scale(zoom, zoom);
      ctx.translate(-dw / 2, -dh / 2);
      ctx.drawImage(buf, 0, 0);
      ctx.restore();

      // 3. Inject a fresh kaleidoscope mandala in CSS-pixel space.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = width / 2;
      const cy = height / 2;
      const minDim = Math.min(width, height);
      const n = bins.length;
      const K = 6; // kaleidoscope wedges

      ctx.save();
      // Normal (source-over) blending, NOT additive: additive sums a rainbow of
      // overlapping hues straight to white at the arm cores. Source-over lets
      // each arm take its own hue directly, so it stays vivid and can never
      // clip past its color. The feedback pass supplies the glow/trails.
      ctx.translate(cx, cy);
      ctx.scale(1 + level * 0.12, 1 + level * 0.12); // bass breathing
      for (let k = 0; k < K; k++) {
        ctx.rotate((Math.PI * 2) / K);
        const wedge = (Math.PI * 2) / K;
        for (let b = 0; b < n; b += 3) {
          const v = bins[b];
          if (v < 0.04) continue;
          const r = 20 + (b / n) * minDim * 0.42;
          const size = 1.5 + v * minDim * 0.03; // thin arms → less overlap→white
          // Fan bands across the wedge so they trace a colored spiral arc rather
          // than stacking on one radial line (which just sums to white).
          const off = ((b / n) - 0.5) * wedge * 0.75;
          const x = Math.cos(off) * r;
          const y = Math.sin(off) * r;
          // Sweep through the album palette along the arm (by radius) and slowly
          // over time, so each arm is a gradient of the cover's own colors.
          const c = samplePalette(pal, (r / minDim) * 1.5 + time * 0.06);
          ctx.fillStyle = `rgba(${c.r | 0}, ${c.g | 0}, ${c.b | 0}, ${0.16 + v * 0.34})`;
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // Subtle central bass core in a palette color (kept dim).
      const core = 0.02 + level;
      const cc = samplePalette(pal, time * 0.1);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.06 * core);
      grad.addColorStop(0, `rgba(${cc.r | 0}, ${cc.g | 0}, ${cc.b | 0}, ${0.15 * core})`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    },
  };
}

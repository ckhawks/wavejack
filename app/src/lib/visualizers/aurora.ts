import type { Visualizer, VizFrame, RGB } from "./types";

/**
 * Flowing aurora: several translucent horizontal ribbons drift and undulate,
 * their crest height driven by different regions of the spectrum (bass ribbons
 * swell on kicks, treble ribbons shimmer). Additive blending over a dark base
 * gives soft light-on-light blooms. The most ambient / least literal of the
 * built-ins — meant to look like art first, meter second.
 */
export function createAurora(): Visualizer {
  const LAYERS = 5;

  return {
    draw({ ctx, width, height, bins, level, palette, time }: VizFrame) {
      // Dark wash keeps blacks deep while additive ribbons accumulate light.
      ctx.fillStyle = "rgba(6,6,10,0.28)";
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      const n = bins.length;
      for (let layer = 0; layer < LAYERS; layer++) {
        // Each ribbon samples a different slice of the spectrum.
        const bandLo = Math.floor((layer / LAYERS) * n);
        const bandHi = Math.floor(((layer + 1) / LAYERS) * n);
        let energy = 0;
        for (let i = bandLo; i < bandHi; i++) energy += bins[i];
        energy /= Math.max(1, bandHi - bandLo);

        const c: RGB = palette[layer % palette.length];
        const baseY = height * (0.25 + (layer / (LAYERS - 1)) * 0.5);
        const amp = height * (0.04 + energy * 0.22);
        const speed = 0.15 + layer * 0.05;
        const freq = 1.2 + layer * 0.6;
        const phase = time * speed + layer * 1.7;

        ctx.beginPath();
        ctx.moveTo(0, height);
        const step = Math.max(4, width / 160);
        for (let x = 0; x <= width; x += step) {
          const u = x / width;
          const y =
            baseY +
            Math.sin(u * Math.PI * freq + phase) * amp +
            Math.sin(u * Math.PI * freq * 2.3 - phase * 1.3) * amp * 0.4;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(width, height);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, baseY - amp, 0, height);
        const alpha = 0.14 + energy * 0.4 + level * 0.1;
        grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${alpha})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fill();
      }
      ctx.restore();
    },
  };
}

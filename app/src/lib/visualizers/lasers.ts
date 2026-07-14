import type { Visualizer, VizFrame } from "./types";
import { vivify } from "./color";

/**
 * Club lasers: rigs fire fans of beams that sweep and cross. Everything is
 * driven by the music — the beams pump continuously with the bass, and each
 * detected kick flares them, flashes the background an album color, and fires a
 * white pop. No free-running strobe: when the track is quiet it's calm, on a
 * busy drop it strobes like a club. Beam and background colors come straight
 * from the album art palette (brightened so they stay vivid).
 *
 * Kick detection is adaptive (fast vs. slow bass envelope) so it works whatever
 * absolute range the spectrum happens to be scaled to.
 */
export function createLasers(): Visualizer {
  let beat = 0; // decaying kick envelope (flare + bg flash)
  let whiteFlash = 0; // decaying full-screen white pop
  let bassFast = 0; // fast bass envelope
  let bassSlow = 0; // slow baseline for adaptive onset threshold
  let lastKickT = -1;
  let motionEnv = 0; // smoothed high-end presence → sets a slow motion speed
  let colorStep = 0; // walks the palette on each kick
  let sweepPhase = 0; // accumulated sweep angle; advances with sustained high-end
  let orientPhase = 0; // slower secondary arrangement drift

  const rigs = [
    { x: 0.1, y: 1.05, base: -Math.PI * 0.35 }, // floor-left, up-right
    { x: 0.9, y: 1.05, base: -Math.PI * 0.65 }, // floor-right, up-left
    { x: 0.5, y: -0.05, base: Math.PI * 0.5 }, // ceiling-center, down
  ];
  const BEAMS = 8;

  // Wash-light "fixtures" scattered around the edges, each throwing a soft cone
  // of colored light inward (apex at the fixture, widening across the room).
  const cones = [
    { x: 0.5, y: -0.06, ang: Math.PI * 0.5, spread: 0.55 }, // top-center → down
    { x: 0.06, y: -0.04, ang: Math.PI * 0.26, spread: 0.42 }, // top-left → down-right
    { x: 0.94, y: -0.04, ang: Math.PI * 0.74, spread: 0.42 }, // top-right → down-left
    { x: 0.2, y: 1.06, ang: -Math.PI * 0.42, spread: 0.42 }, // floor-left → up-right
    { x: 0.8, y: 1.06, ang: -Math.PI * 0.58, spread: 0.42 }, // floor-right → up-left
  ];

  const stroke = (
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    w: number,
  ) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };

  return {
    draw({ ctx, width, height, bins, time, dt, palette }: VizFrame) {
      const pal = (palette.length ? palette : [{ r: 255, g: 60, b: 200 }]).map(vivify);

      // --- Bass: drives IMPACT (flash, color, flare). ---
      const bass = (bins[0] + bins[1] + bins[2] + bins[3] + bins[4] + bins[5]) / 6;
      bassFast += (bass - bassFast) * 0.5;
      bassSlow += (bass - bassSlow) * 0.04;
      const pulse = Math.min(1, bassFast * 1.3); // continuous beam drive
      // Kick onset = fast rise clearly above the slow baseline (additive margin,
      // so it triggers regardless of the spectrum's absolute scale). Slightly
      // longer refractory so a single kick's transient can't double-fire.
      if (bassFast > bassSlow + 0.05 && bassFast > 0.04 && time - lastKickT > 0.16) {
        lastKickT = time;
        beat = 1;
        whiteFlash = 1;
        colorStep += 1;
      }
      beat *= 0.85;
      whiteFlash *= 0.6;

      // --- High end: drives MOTION speed. Uses a SMOOTHED envelope of sustained
      // high-end presence (not transient hits), so the fan drifts slowly and
      // continuously while the top end is busy, and eases to a near-stop when
      // there's none — rather than lurching fast on individual hi-hat hits. ---
      let high = 0;
      const HIGH_START = 24; // lower bin where "high end" begins (lower = more responsive)
      for (let i = HIGH_START; i < bins.length; i++) high += bins[i];
      high /= bins.length - HIGH_START;
      motionEnv += (high - motionEnv) * 0.08; // slow follow → responds to presence, not hits
      const spd = 0.015 + motionEnv * 2.4; // near-still with no highs; faster drift when high end is strong
      // A kick adds a brief burst of movement SPEED (not a position jump), so the
      // beams surge forward on the beat and settle back — motion, no teleport.
      const burst = beat * 2.5;
      sweepPhase += dt * (spd + burst);
      orientPhase += dt * (spd * 0.4 + burst * 0.4); // slower secondary drift + burst

      // --- Background: black + continuous album wash by bass + kick flash. ---
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      const bg = pal[colorStep % pal.length];
      const wash = pulse * 0.1 + beat * 0.32;
      if (wash > 0.01) {
        ctx.fillStyle = `rgba(${bg.r},${bg.g},${bg.b},${Math.min(0.5, wash)})`;
        ctx.fillRect(0, 0, width, height);
      }

      const diag = Math.hypot(width, height);
      const minDim = Math.min(width, height);
      const flare = 1 + beat * 1.6;

      // --- Flood / wash lights: soft album-colored pools that breathe with the
      // music, borrowing the ambient backdrop's glow. Additive, drawn behind the
      // beams so they light the "room" without hiding the lasers. ---
      const washPts = [
        { x: 0.5, y: 1.0 },
        { x: 0.14, y: 1.0 },
        { x: 0.86, y: 1.0 },
        { x: 0.5, y: 0.0 },
      ];
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      washPts.forEach((wp, wi) => {
        const c = pal[(wi + colorStep) % pal.length];
        const px = (wp.x + Math.sin(time * 0.3 + wi) * 0.05) * width; // gentle drift
        const py = wp.y * height;
        const rad = minDim * (0.45 + pulse * 0.2);
        // No always-on floor, so the wash fades fully to black when quiet.
        const a = pulse * 0.12 + beat * 0.2;
        const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${a})`);
        g.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      });
      ctx.restore();

      // --- Light cones: each edge fixture throws a soft colored beam-cone inward
      // (apex bright, fading across the room), gently sweeping. Sits on top of the
      // ambient pools above to give the wash structure/direction. ---
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      cones.forEach((cf, ci) => {
        const c = pal[(ci + colorStep) % pal.length];
        const ax = cf.x * width;
        const ay = cf.y * height;
        const ang = cf.ang + Math.sin(time * 0.15 + ci * 1.3) * 0.12; // slow sweep
        const len = diag * 0.9;
        // Each cone fades in/out on its own slow phase, so only a couple are lit
        // at any moment (like wash fixtures cycling) rather than all at once.
        const gate = Math.max(0, Math.sin(time * 0.4 + ci * 1.7));
        const a = (0.02 + pulse * 0.1 + beat * 0.14) * gate;
        if (a < 0.01) return;
        ctx.save();
        // Blur the whole cone so its triangle edges feather into soft light
        // instead of hard geometric facets. Fill the triangle directly (no clip)
        // so the blur can spread the edges outward.
        ctx.filter = `blur(${Math.max(16, minDim * 0.05)}px)`;
        const cg = ctx.createRadialGradient(ax, ay, 0, ax, ay, len);
        cg.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${a})`);
        cg.addColorStop(0.6, `rgba(${c.r},${c.g},${c.b},${a * 0.4})`);
        cg.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + Math.cos(ang - cf.spread / 2) * len, ay + Math.sin(ang - cf.spread / 2) * len);
        ctx.lineTo(ax + Math.cos(ang + cf.spread / 2) * len, ay + Math.sin(ang + cf.spread / 2) * len);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      rigs.forEach((rig, ri) => {
        const ex = rig.x * width;
        const ey = rig.y * height;
        // (1) energy-driven sweep + (2) beat-stepped orientation that snaps to a
        // new angle on each kick (deterministic per kickStep so all beams in a
        // rig move together, like a cued laser scene).
        // Two incommensurate frequencies → quasi-periodic sweep that never
        // settles into an obvious repeating pattern.
        const sweep =
          Math.sin(sweepPhase * (1 + ri * 0.35) + ri) * 0.34 +
          Math.sin(sweepPhase * 0.53 + ri * 1.7) * 0.2;
        const orient = Math.sin(orientPhase + ri * 2.1) * 0.6;
        const c = pal[(ri + colorStep) % pal.length];
        for (let j = 0; j < BEAMS; j++) {
          // Spread beams across the spectrum from low-mid up to treble,
          // interleaved by rig — but SKIP the sub-bass (below LO), otherwise the
          // innermost beams sit on the ever-present bass and stay permanently
          // lit. Every rig still spans its range and reacts to the high end.
          const LO = 8;
          const g = j * rigs.length + ri; // 0..(BEAMS*rigs.length - 1)
          const band = bins[LO + Math.round((g / (BEAMS * rigs.length - 1)) * (bins.length - 1 - LO))];
          const spread = (j / (BEAMS - 1) - 0.5) * 0.75;
          const ang = rig.base + spread + sweep + orient;
          const len = diag * (0.7 + band * 0.5) * Math.min(1.4, flare);
          const x1 = ex + Math.cos(ang) * len;
          const y1 = ey + Math.sin(ang) * len;
          // Gated brightness: crush anything below a threshold to black, then
          // ramp hard to full. Beams read as ON or OFF (a real laser look)
          // rather than sitting at a dim partial brightness. Bass/beat lift the
          // threshold's payoff so hits punch.
          // Visibility depends ONLY on this beam's own band — not the bass/kick.
          // If the kick boosted alpha, it would shove a scattered set of
          // otherwise-black beams over the cutoff all at once, and since the
          // sweep drifted while they were off they'd pop on at new angles (reads
          // as teleporting). Keeping the gate band-only means the kick changes
          // brightness/length, never *which* beams are lit.
          const lit = Math.max(0, band - 0.14);
          const a = Math.min(1, lit * 2.4);
          // Hard visibility cutoff: below this a beam isn't drawn at all, so it's
          // truly black rather than a faint barely-visible line.
          if (a < 0.2) continue;
          const w = (2 + band * 3) * (0.8 + beat * 0.6);
          stroke(ctx, ex, ey, x1, y1, `rgba(${c.r},${c.g},${c.b},${a * 0.25})`, w * 4);
          stroke(ctx, ex, ey, x1, y1, `rgba(${c.r},${c.g},${c.b},${a})`, w);
          stroke(ctx, ex, ey, x1, y1, `rgba(255,255,255,${a * 0.85})`, Math.max(1, w * 0.35));
        }
      });
      ctx.restore();

      // White pop on the kick — the punchy hit.
      if (whiteFlash > 0.02) {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = `rgba(255,255,255,${whiteFlash * 0.45})`;
        ctx.fillRect(0, 0, width, height);
      }
    },
  };
}

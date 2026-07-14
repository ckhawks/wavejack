import { useEffect, useRef } from "react";
import { usePlayerStore } from "../../stores/playerStore";
import { useSpectrum, SPECTRUM_BANDS } from "../../hooks/useSpectrum";
import { getVisualizer, type RGB, type VizFrame } from "../../lib/visualizers";

interface Props {
  /** Registry id of the visualizer to run (see `lib/visualizers`). */
  visualizerId: string;
  /** Dominant cover colors; drives each visualizer's palette. */
  palette: RGB[];
}

const FALLBACK_PALETTE: RGB[] = [{ r: 120, g: 120, b: 140 }];

/**
 * Full-bleed canvas that drives a spectrum-reactive visualizer. It owns the one
 * rAF loop, DPR-correct sizing, band smoothing (fast attack / slow release) and
 * overall-loudness tracking, then delegates the actual drawing to the
 * visualizer named by `visualizerId`.
 *
 * The loop reads player state and spectrum bins via refs so it runs at native
 * frame rate regardless of unrelated React re-renders — same pattern as
 * `WaveformBar`. It is re-armed only when the visualizer id changes (which
 * needs a fresh instance); palette changes flow in through a ref so switching
 * tracks never resets particle/trail state mid-song.
 */
export function VisualizerCanvas({ visualizerId, palette }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const binsRef = useSpectrum();
  const paletteRef = useRef<RGB[]>(FALLBACK_PALETTE);
  paletteRef.current = palette.length ? palette : FALLBACK_PALETTE;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const entry = getVisualizer(visualizerId);
    if (!entry) return;
    const viz = entry.create();

    let cssW = 0;
    let cssH = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(cssW * dpr));
      canvas.height = Math.max(1, Math.floor(cssH * dpr));
      // Draw in CSS px; the transform maps to the DPR-scaled backing store.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      viz.init?.(cssW, cssH);
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);

    const smooth = new Float32Array(SPECTRUM_BANDS);
    let level = 0;
    let raf = 0;
    const start = performance.now();
    let last = start;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const raw = binsRef.current;
      let sum = 0;
      for (let i = 0; i < SPECTRUM_BANDS; i++) {
        const v = raw[i] ?? 0;
        // Fast attack, slow release — the classic visualizer envelope.
        smooth[i] = v > smooth[i] ? v : smooth[i] + (v - smooth[i]) * 0.18;
        sum += smooth[i];
      }
      level += (sum / SPECTRUM_BANDS - level) * 0.2;

      const f: VizFrame = {
        ctx,
        width: cssW,
        height: cssH,
        bins: smooth,
        level,
        palette: paletteRef.current,
        time: (now - start) / 1000,
        dt,
        isPlaying: usePlayerStore.getState().isPlaying,
      };
      viz.draw(f);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [visualizerId, binsRef]);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { useSpectrum, SPECTRUM_BANDS as BANDS } from "../hooks/useSpectrum";

const HEIGHT = 28;

export function SpectrogramBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Latest bins from Rust, kept in a ref so events don't trigger re-renders —
  // the canvas redraw is rAF-driven.
  const binsRef = useSpectrum();

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!currentTrack) return;
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let raf = 0;
    const draw = () => {
      const bins = binsRef.current;
      ctx.clearRect(0, 0, width, HEIGHT);
      const gap = 1;
      const barW = Math.max(1, (width - (BANDS - 1) * gap) / BANDS);
      for (let i = 0; i < BANDS; i++) {
        const v = bins[i] ?? 0;
        const h = Math.max(1, v * HEIGHT);
        const x = i * (barW + gap);
        const y = HEIGHT - h;
        const hue = 280 - (i / BANDS) * 200;
        ctx.fillStyle = `hsl(${hue}, 70%, ${30 + v * 40}%)`;
        ctx.fillRect(x, y, barW, h);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [currentTrack ? "yes" : "no", width]);

  if (!currentTrack) return null;

  return (
    <div
      ref={containerRef}
      className="border-t border-[#222] bg-[#0a0a0a] px-4"
      style={{ height: HEIGHT }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: HEIGHT, display: "block" }} />
    </div>
  );
}

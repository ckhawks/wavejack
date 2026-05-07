import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { usePlayerStore } from "../stores/playerStore";

const HEIGHT = 28;
// Match SPECTRUM_BANDS in audio.rs. The Rust side log-buckets the FFT and
// pushes a Vec<f32> at ~60Hz; we just render whatever it sends.
const BANDS = 48;

interface SpectrumPayload {
  bins: number[];
}

export function SpectrogramBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Latest bins from Rust. A ref so the listener doesn't trigger React
  // re-renders on every event — the canvas redraw is rAF-driven.
  const binsRef = useRef<number[]>(new Array(BANDS).fill(0));

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  // Subscribe to spectrum events for the lifetime of the component.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SpectrumPayload>("audio://spectrum", (e) => {
      binsRef.current = e.payload.bins;
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
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

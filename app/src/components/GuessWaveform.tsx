import { useEffect, useRef, useState } from "react";
import { getOrComputeWaveform } from "../lib/commands";

const BAR_GAP = 1;

/**
 * Static, player-independent waveform. Fetches the cached 500-bucket amplitude
 * profile for a path and draws it once — no playhead, no seeking. Used by the
 * guessing game's "match the waveform" mode, where coupling to the player store
 * (as WaveformBar does) would be wrong.
 */
export function GuessWaveform({ path, height = 96 }: { path: string; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [profile, setProfile] = useState<number[] | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    setProfile(null);
    let cancelled = false;
    getOrComputeWaveform(path)
      .then((data) => !cancelled && setProfile(data))
      .catch((e) => console.error("Waveform load failed:", e));
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    if (!profile) {
      ctx.fillStyle = "#222";
      ctx.fillRect(0, height / 2 - 1, width, 2);
      return;
    }
    const buckets = profile.length;
    const barWidth = Math.max(1, (width - (buckets - 1) * BAR_GAP) / buckets);
    ctx.fillStyle = "#a78bfa"; // violet-400 to match the app accent
    for (let i = 0; i < buckets; i++) {
      const x = i * (barWidth + BAR_GAP);
      const h = Math.max(2, (profile[i] / 255) * height);
      ctx.fillRect(x, (height - h) / 2, barWidth, h);
    }
  }, [profile, width, height]);

  return (
    <div ref={containerRef} style={{ height }} className="w-full">
      <canvas ref={canvasRef} style={{ width: "100%", height, display: "block" }} />
    </div>
  );
}

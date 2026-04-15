import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { getOrComputeWaveform } from "../lib/commands";

const BAR_GAP = 1; // px between bars

interface WaveformBarProps {
  /** Render without the player-bar chrome (border + dark background). Use in
   * the immersive view where the parent already supplies a backdrop. */
  bare?: boolean;
  /** Override the canvas height. Defaults to 48px in normal mode. */
  height?: number;
  /** CSS color string for the played portion. Defaults to white. */
  playedColor?: string;
  /** CSS color string for the unplayed portion. Defaults to a dim gray. */
  unplayedColor?: string;
}

/**
 * SoundCloud-style waveform shown above the player bar. Loads (and caches)
 * a 500-bucket amplitude profile per track from Rust, draws as vertical
 * bars on a canvas, highlights the played portion, and supports click-to-seek.
 */
export function WaveformBar({
  bare = false,
  height = 48,
  playedColor = "#ffffff",
  unplayedColor = "#444444",
}: WaveformBarProps = {}) {
  const HEIGHT = height;
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [profile, setProfile] = useState<number[] | null>(null);
  const [width, setWidth] = useState(0);
  /** Sub-frame interpolated playhead time, refreshed via rAF while playing. */
  const [smoothTime, setSmoothTime] = useState(0);

  const appearStartRef = useRef<number>(0);
  const [appearProgress, setAppearProgress] = useState(0);

  // Reset + fetch on track change
  useEffect(() => {
    setProfile(null);
    setAppearProgress(0);
    if (!currentTrack?.filePath) return;
    let cancelled = false;
    getOrComputeWaveform(currentTrack.filePath)
      .then((data) => {
        if (!cancelled) {
          setProfile(data);
          appearStartRef.current = performance.now();
        }
      })
      .catch((e) => console.error("Waveform load failed:", e));
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.filePath]);

  // Smooth playhead: read audio.currentTime each animation frame so the
  // waveform updates at ~60Hz rather than the audio element's ~4Hz timeupdate.
  useEffect(() => {
    const audio = document.querySelector("audio");
    if (!audio) return;
    let raf = 0;
    const tick = () => {
      setSmoothTime(audio.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, currentTrack?.filePath]);

  // Cascade-in animation: drive appearProgress 0 -> 1 over ~600ms after load.
  useEffect(() => {
    if (!profile) return;
    let raf = 0;
    const DURATION = 600;
    const tick = (now: number) => {
      const t = Math.min(1, (now - appearStartRef.current) / DURATION);
      setAppearProgress(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [profile]);

  // Track container width for the canvas
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, HEIGHT);

    // Loading state — flat dim line so the bar doesn't feel broken.
    if (!profile) {
      ctx.fillStyle = "#222";
      ctx.fillRect(0, HEIGHT / 2 - 1, width, 2);
      return;
    }

    const buckets = profile.length;
    const totalBarPx = width;
    const barWidth = Math.max(1, (totalBarPx - (buckets - 1) * BAR_GAP) / buckets);
    // Prefer the rAF-driven smooth time; fall back to the store value
    // (e.g. just after a seek before the next frame).
    const t = smoothTime || currentTime;
    const playedRatio = duration > 0 ? Math.min(1, t / duration) : 0;

    // Cascade-in: each bar grows from a flat line to its full amplitude as
    // a wave sweeps left-to-right. CASCADE_SPAN controls how many bars are
    // mid-animation at any instant (lower = sharper, higher = softer).
    const CASCADE_SPAN = 0.25;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    // Build one path with all bars, then fill once with a horizontal gradient
    // so the played/unplayed edge can fall mid-bar instead of snapping to bar
    // boundaries.
    const path = new Path2D();
    for (let i = 0; i < buckets; i++) {
      const x = i * (barWidth + BAR_GAP);
      const amp = profile[i] / 255;
      const localT = Math.max(
        0,
        Math.min(1, (appearProgress - (i / buckets) * (1 - CASCADE_SPAN)) / CASCADE_SPAN),
      );
      const h = Math.max(2, amp * HEIGHT * easeOut(localT));
      const y = (HEIGHT - h) / 2;
      path.rect(x, y, barWidth, h);
    }

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    const seamPx = 2;
    const seamRatio = width > 0 ? seamPx / width : 0;
    const left = Math.max(0, playedRatio - seamRatio);
    const right = Math.min(1, playedRatio + seamRatio);
    gradient.addColorStop(0, playedColor);
    gradient.addColorStop(left, playedColor);
    gradient.addColorStop(right, unplayedColor);
    gradient.addColorStop(1, unplayedColor);
    ctx.fillStyle = gradient;
    ctx.fill(path);
  }, [profile, width, currentTime, smoothTime, duration, appearProgress, playedColor, unplayedColor]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || duration <= 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const t = Math.max(0, Math.min(duration, ratio * duration));
    setCurrentTime(t);
    const audio = document.querySelector("audio");
    if (audio) audio.currentTime = t;
  };

  if (!currentTrack) return null;

  const className = bare ? "" : "border-t border-[#222] bg-[#0a0a0a] px-4";

  return (
    <div ref={containerRef} className={className} style={{ height: HEIGHT }}>
      <canvas
        ref={canvasRef}
        onClick={onClick}
        style={{ width: "100%", height: HEIGHT, display: "block", cursor: "pointer" }}
      />
    </div>
  );
}

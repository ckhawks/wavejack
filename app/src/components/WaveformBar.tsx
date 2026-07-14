import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../stores/playerStore";
import { getOrComputeWaveform, audioSeek } from "../lib/commands";

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
 *
 * The animation is driven entirely imperatively inside a single rAF loop that
 * reads player state via `getState()` and draws straight to the canvas — it
 * holds NO per-frame React state and does NOT subscribe to the ~60Hz
 * `currentTime`. That keeps the waveform running at native frame rate even when
 * React is busy re-rendering elsewhere (e.g. a flood of download-progress
 * events), which used to starve the old state-driven redraw.
 */
export function WaveformBar({
  bare = false,
  height = 48,
  playedColor = "#ffffff",
  unplayedColor = "#444444",
}: WaveformBarProps = {}) {
  const HEIGHT = height;
  // Subscribed values only change on track change / seek / resize — never
  // per-frame — so they don't cause animation-rate re-renders.
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const duration = usePlayerStore((s) => s.duration);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [profile, setProfile] = useState<number[] | null>(null);
  const [width, setWidth] = useState(0);

  /** Wall-clock time (performance.now) when the current profile loaded, so the
   * rAF loop can compute the 0→1 cascade-in progress without React state. */
  const appearStartRef = useRef<number>(0);

  // Reset + fetch on track change
  useEffect(() => {
    setProfile(null);
    if (!currentTrack?.filePath) return;
    let cancelled = false;
    getOrComputeWaveform(currentTrack.filePath)
      .then((data) => {
        if (!cancelled) {
          appearStartRef.current = performance.now();
          setProfile(data);
        }
      })
      .catch((e) => console.error("Waveform load failed:", e));
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.filePath]);

  // Track container width for the canvas
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    setWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  // Size the backing store only when the dimensions change. Setting canvas.width
  // resets the context transform, so re-apply the DPR scale here — doing this in
  // the per-frame draw would needlessly clear and rescale 60x/sec.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(HEIGHT * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.scale(dpr, dpr);
  }, [width, HEIGHT]);

  // Single imperative rAF loop: computes the smooth playhead + cascade-in
  // progress from wall-clock time and the store, then draws directly. Re-armed
  // only when the profile, size, or colors change — never per frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Loading state — flat dim line so the bar doesn't feel broken. No loop.
    if (!profile) {
      ctx.clearRect(0, 0, width, HEIGHT);
      ctx.fillStyle = "#222";
      ctx.fillRect(0, HEIGHT / 2 - 1, width, 2);
      return;
    }

    // Static bar geometry inputs. Position bars on a fixed stride of
    // width/buckets so they ALWAYS span exactly 0..width. Deriving x from a
    // clamped barWidth (min 1px) overflowed the canvas whenever there were more
    // buckets than pixels — e.g. the narrower fullscreen waveform (~768px vs
    // ~500 buckets) — which pushed the end of the song off the right edge and
    // clipped it. The wide bottom bar stayed under the clamp, so it looked fine.
    const buckets = profile.length;
    const stride = width / buckets;
    const barWidth = Math.max(1, stride - BAR_GAP);
    // Cascade-in: each bar grows from a flat line to full amplitude as a wave
    // sweeps left-to-right. CASCADE_SPAN = how many bars are mid-animation at
    // once (lower = sharper). Runs over ~600ms after load.
    const CASCADE_SPAN = 0.25;
    const CASCADE_MS = 600;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    const buildPath = (appearProgress: number) => {
      const path = new Path2D();
      for (let i = 0; i < buckets; i++) {
        const x = i * stride;
        const amp = profile[i] / 255;
        const localT = Math.max(
          0,
          Math.min(1, (appearProgress - (i / buckets) * (1 - CASCADE_SPAN)) / CASCADE_SPAN),
        );
        const h = Math.max(2, amp * HEIGHT * easeOut(localT));
        const y = (HEIGHT - h) / 2;
        path.rect(x, y, barWidth, h);
      }
      return path;
    };

    // Cache the settled path once the cascade finishes so steady-state frames
    // are just clear + gradient fill, not 500 rect() calls.
    let settledPath: Path2D | null = null;
    // Smooth-playhead anchoring: interpolate between the store's ~60Hz ticks.
    let lastTime = usePlayerStore.getState().currentTime;
    let lastWall = performance.now();
    let raf = 0;

    const draw = (now: number) => {
      const store = usePlayerStore.getState();
      // Re-anchor whenever the store's currentTime jumps (event tick or seek).
      if (Math.abs(store.currentTime - lastTime) > 0.01) {
        lastTime = store.currentTime;
        lastWall = now;
      }
      const drift = store.isPlaying ? (now - lastWall) / 1000 : 0;
      const t = lastTime + drift;

      const appearProgress = Math.min(1, (now - appearStartRef.current) / CASCADE_MS);
      let path: Path2D;
      if (appearProgress >= 1) {
        if (!settledPath) settledPath = buildPath(1);
        path = settledPath;
      } else {
        path = buildPath(appearProgress);
      }

      ctx.clearRect(0, 0, width, HEIGHT);
      const dur = store.duration;
      const playedRatio = dur > 0 ? Math.min(1, t / dur) : 0;
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      const seamRatio = width > 0 ? 2 / width : 0;
      const left = Math.max(0, playedRatio - seamRatio);
      const right = Math.min(1, playedRatio + seamRatio);
      gradient.addColorStop(0, playedColor);
      gradient.addColorStop(left, playedColor);
      gradient.addColorStop(right, unplayedColor);
      gradient.addColorStop(1, unplayedColor);
      ctx.fillStyle = gradient;
      ctx.fill(path);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [profile, width, HEIGHT, playedColor, unplayedColor]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || duration <= 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const t = Math.max(0, Math.min(duration, ratio * duration));
    setCurrentTime(t);
    audioSeek(t).catch((e) => console.error("audio_seek failed:", e));
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

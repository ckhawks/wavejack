import { useEffect, useRef, useState } from "react";
import { X, Shuffle, Volume2, VolumeX } from "lucide-react";
import { usePlayerStore } from "../stores/playerStore";
import { extractDominantColors, type DominantColor } from "../lib/colorThief";
import { WaveformBar } from "./WaveformBar";
import { VisualizerCanvas } from "./visualizers/VisualizerCanvas";
import { BACKDROP_OPTIONS, AMBIENT_ID } from "../lib/visualizers";

interface Props {
  onClose: () => void;
}

/** Persist the chosen immersive backdrop across sessions. Frontend-only, so a
 * localStorage key rather than a Rust-side setting. */
const BACKDROP_KEY = "wj.immersive.backdrop";
function loadBackdrop(): string {
  try {
    const v = localStorage.getItem(BACKDROP_KEY);
    if (v && BACKDROP_OPTIONS.some((o) => o.id === v)) return v;
  } catch {
    // localStorage can throw in locked-down webviews; fall back to default.
  }
  return AMBIENT_ID;
}

/** Lift an RGB color's lightness in HSL space to at least `minL` (0..1).
 * Returns the same color unchanged if it's already bright enough. */
function brighten(c: { r: number; g: number; b: number }, minL: number) {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (l >= minL) return { r: c.r, g: c.g, b: c.b };
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  // Bump lightness; keep saturation strong so it stays vivid.
  const newL = minL;
  const newS = Math.max(s, 0.5);
  const c1 = (1 - Math.abs(2 * newL - 1)) * newS;
  const x = c1 * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = newL - c1 / 2;
  let rr = 0, gg = 0, bb = 0;
  if (h < 60) { rr = c1; gg = x; }
  else if (h < 120) { rr = x; gg = c1; }
  else if (h < 180) { gg = c1; bb = x; }
  else if (h < 240) { gg = x; bb = c1; }
  else if (h < 300) { rr = x; bb = c1; }
  else { rr = c1; bb = x; }
  return {
    r: Math.round((rr + m) * 255),
    g: Math.round((gg + m) * 255),
    b: Math.round((bb + m) * 255),
  };
}

function PlayIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.14v14l11-7-11-7z" />
    </svg>
  );
}
function PauseIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}
function PrevIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
    </svg>
  );
}
function NextIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 18h2V6h-2zM6 18l8.5-6L6 6z" />
    </svg>
  );
}

export function ImmersivePlayer({ onClose }: Props) {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const playNext = usePlayerStore((s) => s.playNext);
  const playPrev = usePlayerStore((s) => s.playPrev);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

  const [colors, setColors] = useState<DominantColor[]>([]);
  const [backdrop, setBackdrop] = useState<string>(loadBackdrop);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectBackdrop = (id: string) => {
    setBackdrop(id);
    try {
      localStorage.setItem(BACKDROP_KEY, id);
    } catch {
      // Non-fatal: the choice just won't persist.
    }
  };

  // Extract dominant colors per track
  useEffect(() => {
    if (!currentTrack?.coverArtBase64) {
      setColors([]);
      return;
    }
    let cancelled = false;
    extractDominantColors(`data:image/jpeg;base64,${currentTrack.coverArtBase64}`, 3)
      .then((c) => {
        if (!cancelled) setColors(c);
      })
      .catch(() => setColors([]));
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.coverArtBase64]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!currentTrack) return null;

  const palette = colors.length > 0 ? colors : [{ r: 30, g: 30, b: 30, count: 1 }];

  // Pick the brightest dominant color for the waveform "played" segment, then
  // boost its lightness in HSL space so it always reads as bright/vivid even
  // when the cover's brightest color is itself fairly dark.
  const luminance = (c: DominantColor) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const accent = palette.slice().sort((a, b) => luminance(b) - luminance(a))[0];
  const bright = brighten(accent, 0.7); // floor lightness at 70%
  const playedColor = `rgb(${bright.r},${bright.g},${bright.b})`;
  // Unplayed must be OPAQUE, not a low-alpha tint: the immersive backdrop (color
  // blobs / visualizer) shows through a translucent fill and, over a bright
  // blob, washes the unplayed bars up to the same brightness as the played
  // ones — hiding the playhead so it looks like the track isn't progressing. A
  // dimmed-but-opaque accent keeps the hue while guaranteeing the seam is
  // visible over any background.
  const unplayedColor = `rgb(${Math.round(bright.r * 0.35)},${Math.round(
    bright.g * 0.35,
  )},${Math.round(bright.b * 0.35)})`;

  return (
    <div
      ref={containerRef}
      data-tauri-drag-region
      className="fixed inset-0 z-[60] flex flex-col overflow-hidden bg-black text-white"
    >
      {/* Animated color background — each dominant color is its own slow-
          drifting blob via CSS keyframes (defined inline below). */}
      <style>{`
        @keyframes wj-blob-drift-0 {
          0%, 100% { transform: translate(0%, 0%) scale(1); }
          50%      { transform: translate(8%, 6%) scale(1.15); }
        }
        @keyframes wj-blob-drift-1 {
          0%, 100% { transform: translate(0%, 0%) scale(1.1); }
          50%      { transform: translate(-10%, 8%) scale(0.95); }
        }
        @keyframes wj-blob-drift-2 {
          0%, 100% { transform: translate(0%, 0%) scale(0.95); }
          50%      { transform: translate(6%, -8%) scale(1.2); }
        }
      `}</style>
      <div className="pointer-events-none absolute inset-0 bg-[#0a0a0a]" />
      {backdrop === AMBIENT_ID ? (
        palette.map((c, i) => {
          const placements = [
            { left: "-15%", top: "-10%", w: "70vw", h: "70vh", anim: "wj-blob-drift-0", dur: "12s" },
            { right: "-15%", top: "10%", w: "60vw", h: "60vh", anim: "wj-blob-drift-1", dur: "16s" },
            { left: "20%", bottom: "-20%", w: "80vw", h: "60vh", anim: "wj-blob-drift-2", dur: "20s" },
          ];
          const p = placements[i % placements.length];
          return (
            <div
              key={i}
              className="pointer-events-none absolute rounded-full opacity-90 mix-blend-screen blur-3xl transition-[background] duration-1000"
              style={{
                left: p.left,
                right: p.right,
                top: p.top,
                bottom: p.bottom,
                width: p.w,
                height: p.h,
                background: `radial-gradient(circle, rgba(${c.r},${c.g},${c.b},0.85) 0%, rgba(${c.r},${c.g},${c.b},0) 70%)`,
                animation: `${p.anim} ${p.dur} ease-in-out infinite`,
              }}
            />
          );
        })
      ) : (
        <VisualizerCanvas visualizerId={backdrop} palette={palette} />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/70" />

      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute right-6 top-6 z-30 rounded-full bg-black/40 p-2 text-white/80 backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
        title="Exit immersive mode (Esc)"
      >
        <X size={20} />
      </button>

      {/* Backdrop / visualizer picker */}
      <div className="absolute left-6 top-6 z-30 flex items-center gap-1 rounded-full bg-black/40 p-1 backdrop-blur">
        {BACKDROP_OPTIONS.map((o) => (
          <button
            key={o.id}
            onClick={() => selectBackdrop(o.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              backdrop === o.id
                ? "bg-white/90 text-black"
                : "text-white/70 hover:bg-white/10 hover:text-white"
            }`}
            title={`${o.name} background`}
          >
            {o.name}
          </button>
        ))}
      </div>

      {/* Center content: album art → title/artist → waveform. The empty areas
          and the album art are drag regions so the window can be moved while in
          this fake-fullscreen overlay; interactive children (waveform, buttons)
          still receive their own events. */}
      <div
        data-tauri-drag-region
        className="relative z-10 flex flex-1 flex-col items-center justify-center gap-6 px-8"
      >
        {/* Album art */}
        <div
          data-tauri-drag-region
          className="aspect-square h-[50vh] max-h-[560px] min-h-[240px] overflow-hidden rounded-2xl shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        >
          {currentTrack.coverArtBase64 ? (
            <img
              data-tauri-drag-region
              src={`data:image/jpeg;base64,${currentTrack.coverArtBase64}`}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              data-tauri-drag-region
              className="flex h-full w-full items-center justify-center bg-[#1a1a1a] text-neutral-700"
            >
              <PlayIcon size={64} />
            </div>
          )}
        </div>

        {/* Title / Artist */}
        <div className="text-center">
          <p className="text-3xl font-semibold tracking-tight">{currentTrack.title}</p>
          {currentTrack.artist && (
            <p className="mt-2 text-lg text-white/70">{currentTrack.artist}</p>
          )}
        </div>

        {/* Waveform under the artist */}
        <div className="w-full max-w-3xl">
          <WaveformBar bare height={56} playedColor={playedColor} unplayedColor={unplayedColor} />
        </div>
      </div>

      {/* Bottom row: playback controls + shuffle/volume on the right */}
      <div
        data-tauri-drag-region
        className="relative z-10 flex items-center justify-between gap-6 px-8 pb-8"
      >
        <div data-tauri-drag-region className="w-40" />{/* spacer to balance the row */}
        <div className="flex items-center gap-6">
          <button
            onClick={playPrev}
            className="rounded p-2 text-white/80 hover:text-white"
            title="Previous"
          >
            <PrevIcon size={28} />
          </button>
          <button
            onClick={togglePlayPause}
            className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105"
          >
            {isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={28} />}
          </button>
          <button
            onClick={playNext}
            className="rounded p-2 text-white/80 hover:text-white"
            title="Next"
          >
            <NextIcon size={28} />
          </button>
        </div>
        <div className="flex w-40 items-center justify-end gap-3 text-white/70">
          <button
            onClick={toggleShuffle}
            className={`hover:text-white ${shuffle ? "text-violet-300" : ""}`}
            title="Shuffle"
          >
            <Shuffle size={18} />
          </button>
          <button
            onClick={() => setVolume(volume === 0 ? 0.5 : 0)}
            className="hover:text-white"
            title={volume === 0 ? "Unmute" : "Mute"}
          >
            {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="h-1 w-24 cursor-pointer appearance-none rounded-full outline-none"
            style={{
              background: `linear-gradient(to right, rgba(255,255,255,0.85) ${volume * 100}%, rgba(255,255,255,0.2) ${volume * 100}%)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

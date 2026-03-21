import { useState, useRef, useEffect, useCallback } from "react";
import { Volume2, VolumeX, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { usePlayerStore } from "../stores/playerStore";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Inline SVG icons that look clean at small sizes */
function PlayIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.14v14l11-7-11-7z" />
    </svg>
  );
}

function PauseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PrevIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
    </svg>
  );
}

function NextIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 18h2V6h-2zM6 18l8.5-6L6 6z" />
    </svg>
  );
}

/** Range slider with a filled left track */
function Slider({
  min,
  max,
  value,
  onChange,
  className = "",
}: {
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;

  return (
    <input
      type="range"
      min={min}
      max={max}
      step={max <= 1 ? 0.01 : 1}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className={`h-1 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white ${className}`}
      style={{
        background: `linear-gradient(to right, #fff ${pct}%, #333 ${pct}%)`,
      }}
    />
  );
}

export function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [showArt, setShowArt] = useState(false);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const volume = usePlayerStore((s) => s.volume);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setDuration = usePlayerStore((s) => s.setDuration);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const playNext = usePlayerStore((s) => s.playNext);
  const playPrev = usePlayerStore((s) => s.playPrev);
  const stop = usePlayerStore((s) => s.stop);
  const setVolume = usePlayerStore((s) => s.setVolume);

  // Load new track
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    audio.src = convertFileSrc(currentTrack.filePath);
    audio.volume = usePlayerStore.getState().volume;
    audio.load();
    audio.play().catch(() => {});
  }, [currentTrack?.id, currentTrack?.filePath]);

  // Sync play/pause state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (isPlaying) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [isPlaying, currentTrack]);

  // Sync volume
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (audio) setCurrentTime(audio.currentTime);
  }, [setCurrentTime]);

  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (audio) setDuration(audio.duration);
  }, [setDuration]);

  const onEnded = useCallback(() => {
    playNext();
  }, [playNext]);

  const handleSeek = (val: number) => {
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = val;
      setCurrentTime(val);
    }
  };

  if (!currentTrack) return null;

  return (
    <>
      {/* Expanded album art overlay */}
      {showArt && currentTrack.coverArtBase64 && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85"
          onClick={() => setShowArt(false)}
        >
          <img
            src={`data:image/jpeg;base64,${currentTrack.coverArtBase64}`}
            alt=""
            className="max-h-[70vh] max-w-[70vw] rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 z-50 flex h-16 items-center gap-3 border-t border-[#222] bg-[#111] px-4">
        <audio
          ref={audioRef}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={onEnded}
        />

        {/* Album art — clickable to expand */}
        <button
          className="h-10 w-10 shrink-0 overflow-hidden rounded bg-[#222]"
          onClick={() => currentTrack.coverArtBase64 && setShowArt(true)}
        >
          {currentTrack.coverArtBase64 ? (
            <img
              src={`data:image/jpeg;base64,${currentTrack.coverArtBase64}`}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-neutral-600">
              <PlayIcon size={16} />
            </div>
          )}
        </button>

        {/* Track info */}
        <div className="min-w-0 w-36 shrink-0">
          <p className="truncate text-sm font-medium text-white">{currentTrack.title}</p>
          {currentTrack.artist && (
            <p className="truncate text-xs text-neutral-400">{currentTrack.artist}</p>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1">
          <button onClick={playPrev} className="rounded p-1.5 text-neutral-400 hover:text-white">
            <PrevIcon size={18} />
          </button>
          <button
            onClick={togglePlayPause}
            className="rounded-full bg-white p-1.5 text-black hover:bg-neutral-200"
          >
            {isPlaying ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
          </button>
          <button onClick={playNext} className="rounded p-1.5 text-neutral-400 hover:text-white">
            <NextIcon size={18} />
          </button>
        </div>

        {/* Seek bar */}
        <span className="w-10 shrink-0 text-right text-xs text-neutral-500">
          {formatTime(currentTime)}
        </span>
        <Slider
          min={0}
          max={duration || 0}
          value={currentTime}
          onChange={handleSeek}
          className="mx-1 flex-1"
        />
        <span className="w-10 shrink-0 text-xs text-neutral-500">
          {formatTime(duration)}
        </span>

        {/* Volume */}
        <div className="flex items-center gap-1">
          {volume === 0 ? (
            <VolumeX size={14} className="text-neutral-400" />
          ) : (
            <Volume2 size={14} className="text-neutral-400" />
          )}
          <Slider
            min={0}
            max={1}
            value={volume}
            onChange={setVolume}
            className="w-20"
          />
        </div>

        {/* Close */}
        <button onClick={stop} className="ml-1 rounded p-1 text-neutral-600 hover:text-white">
          <X size={14} />
        </button>
      </div>
    </>
  );
}

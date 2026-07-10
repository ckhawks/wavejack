import { useState, useEffect, useCallback, useRef } from "react";
import { Volume2, VolumeX, X, Shuffle, Maximize2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { usePlayerStore } from "../stores/playerStore";
import { useDiscoverStore } from "../stores/discoverStore";
import {
  recordTrackPlay,
  recordPlayStart,
  audioLoad,
  audioPlay,
  audioPause,
  audioStop,
  audioSeek,
  audioSetVolume,
} from "../lib/commands";
import { useLibraryStore } from "../stores/libraryStore";
import { SILENT_AUDIO_DATA_URI } from "../lib/silentAudio";
import { WaveformBar } from "./WaveformBar";
import { SpectrogramBar } from "./SpectrogramBar";
import { ImmersivePlayer } from "./ImmersivePlayer";

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
  const [showImmersive, setShowImmersive] = useState(false);
  // Near-silent looping element that keeps Chromium's MediaSession active.
  // Real audio plays in the Rust process (rodio), which the webview can't feed
  // to MediaSession — without a playing media element in the DOM, the OS media
  // transport (Windows SMTC / hardware media keys) never routes to our handlers.
  const keepAliveRef = useRef<HTMLAudioElement>(null);
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
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const stop = usePlayerStore((s) => s.stop);
  const setVolume = usePlayerStore((s) => s.setVolume);

  // Load new track natively. The Rust side decodes via symphonia and plays
  // through rodio, so the audible output comes from the wavejack process.
  useEffect(() => {
    if (!currentTrack) return;
    let cancelled = false;
    // Seed the end-time from the library's scanned duration so the seek bar is
    // usable immediately — the playback engine can't determine duration for
    // some files (e.g. headerless VBR MP3), and progress ticks only ever raise
    // it when the engine does know it.
    if (currentTrack.durationSecs && currentTrack.durationSecs > 0) {
      setDuration(currentTrack.durationSecs);
    }
    // Log the play start for the Recent view. Only library tracks have a stable
    // path we can join back to metadata (their id IS the path); download-only
    // tracks use a UUID and are skipped. Mirrors the onEnded gate below.
    const isLibraryTrack = useLibraryStore
      .getState()
      .tracks.some((t) => t.path === currentTrack.filePath);
    if (isLibraryTrack) {
      recordPlayStart(currentTrack.filePath).catch((e) =>
        console.error("record_play_start failed:", e),
      );
    }
    audioLoad(currentTrack.filePath)
      .then((result) => {
        if (cancelled) return;
        if (result.duration > 0) setDuration(result.duration);
        // Honor the persisted shouldPlay state — the store sets isPlaying
        // = true on playTrack, so this is the common path. If the user
        // pressed pause between selecting and loading, leave it paused.
        if (usePlayerStore.getState().isPlaying) {
          void audioPlay();
        }
      })
      .catch((e) => console.error("audio_load failed:", e));
    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, currentTrack?.filePath, setDuration]);

  // Sync play/pause state with the Rust player, and mirror it onto the
  // keep-alive element + MediaSession so the OS transport stays live and shows
  // the correct play/pause state. The keep-alive element must be playing for
  // Chromium to expose the system controls at all.
  useEffect(() => {
    if (!currentTrack) return;
    const keepAlive = keepAliveRef.current;
    if (isPlaying) {
      void audioPlay();
      // play() may reject before a user gesture; the click that started
      // playback satisfies the gesture requirement in practice.
      keepAlive?.play().catch(() => {});
    } else {
      void audioPause();
      keepAlive?.pause();
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }
  }, [isPlaying, currentTrack]);

  // Sync volume
  useEffect(() => {
    void audioSetVolume(volume);
  }, [volume]);

  // Subscribe to Rust-side progress + ended events. The Rust emitter
  // ticks at ~60Hz with the authoritative playback time (frozen during
  // pauses, advanced by rodio's monotonic position counter).
  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenEnded: (() => void) | undefined;
    listen<{ currentTime: number; duration: number }>("audio://progress", (e) => {
      const { currentTime, duration } = e.payload;
      const store = usePlayerStore.getState();
      if (!store.currentTrack) return;
      // Only ever raise duration from the engine when it actually knows it
      // (>0). Many files report no engine duration, in which case the scanned
      // library duration set on load stands. `audio_load` zeroes duration_secs
      // during a track swap, so a stale end-time can't leak in here.
      if (duration > 0 && store.duration !== duration) setDuration(duration);
      setCurrentTime(currentTime);
    }).then((u) => {
      unlistenProgress = u;
    });
    listen<string>("audio://ended", () => {
      onEndedRef.current?.();
    }).then((u) => {
      unlistenEnded = u;
    });
    return () => {
      unlistenProgress?.();
      unlistenEnded?.();
    };
  }, [setCurrentTime, setDuration]);

  // Register with OS media transport controls (MediaSession API) so hardware
  // media keys, Stream Deck buttons, and Windows media overlays work.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
    const artwork: MediaImage[] = [];
    if (currentTrack.coverArtBase64) {
      artwork.push({
        src: `data:image/jpeg;base64,${currentTrack.coverArtBase64}`,
        sizes: "512x512",
        type: "image/jpeg",
      });
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist ?? "",
      artwork,
    });
  }, [currentTrack?.id, currentTrack?.title, currentTrack?.artist, currentTrack?.coverArtBase64]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => {
      if (!usePlayerStore.getState().isPlaying) togglePlayPause();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (usePlayerStore.getState().isPlaying) togglePlayPause();
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => playPrev());
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null) {
        void audioSeek(details.seekTime);
        setCurrentTime(details.seekTime);
      }
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      void audioStop();
      stop();
    });
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("seekto", null);
      navigator.mediaSession.setActionHandler("stop", null);
    };
  }, [togglePlayPause, playPrev, playNext, setCurrentTime, stop]);

  // Keep OS media session position state in sync for seek bar overlays.
  // Throttled to ~4Hz: the OS overlay only needs a coarse position, and
  // calling into the media transport on every progress tick is pure overhead.
  const lastPositionSyncRef = useRef(0);
  useEffect(() => {
    if (!("mediaSession" in navigator) || !duration) return;
    const now = performance.now();
    if (now - lastPositionSyncRef.current < 250) return;
    lastPositionSyncRef.current = now;
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(currentTime, duration),
    });
  }, [currentTime, duration]);

  const onEnded = useCallback(() => {
    const discover = useDiscoverStore.getState();
    const currentDiscover = discover.queue[discover.currentIndex];
    const playing = usePlayerStore.getState().currentTrack;

    // Natural end → record a play if this is a library track. Library tracks
    // use the file path as their id; download-only tracks use a UUID.
    if (playing) {
      const isLibraryTrack = useLibraryStore
        .getState()
        .tracks.some((t) => t.path === playing.filePath);
      if (isLibraryTrack) {
        recordTrackPlay(playing.filePath)
          .then(() => useLibraryStore.getState().refresh())
          .catch((e) => console.error("record_track_play failed:", e));
      }
    }

    if (currentDiscover && playing && currentDiscover.id === playing.id) {
      discover.skipCurrent();
      return;
    }
    playNext();
  }, [playNext]);

  // The audio://ended listener is attached once with a stable closure; route
  // through a ref so the latest onEnded (which closes over fresh playNext)
  // is always invoked without re-binding the listener.
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  const handleSeek = (val: number) => {
    setCurrentTime(val);
    audioSeek(val).catch((e) => console.error("audio_seek failed:", e));
  };

  // When the user explicitly stops, also tear down the native player so the
  // device handle is released and no stray ended event fires.
  const handleStop = useCallback(() => {
    void audioStop();
    stop();
  }, [stop]);

  if (!currentTrack) return null;

  return (
    <>
      {/* Keep-alive: a looping near-silent clip that holds the OS MediaSession
          active. Not muted (muted elements don't activate SMTC); its content is
          silence, so nothing is audible. Playback state is driven by the
          play/pause sync effect above. */}
      <audio ref={keepAliveRef} src={SILENT_AUDIO_DATA_URI} loop preload="auto" />

      {/* Immersive (full-screen now playing) mode */}
      {showImmersive && <ImmersivePlayer onClose={() => setShowImmersive(false)} />}

      <div className="fixed bottom-0 left-0 right-0 z-50">
        <SpectrogramBar />
        <WaveformBar />
      <div className="flex h-16 items-center gap-3 border-t border-[#222] bg-[#111] px-4">
        {/* Album art — clickable to expand */}
        <button
          className="h-10 w-10 shrink-0 overflow-hidden rounded bg-[#222]"
          onClick={() => setShowImmersive(true)}
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
        <div className="min-w-0 w-64 shrink-0">
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

        {/* Shuffle */}
        <button
          onClick={toggleShuffle}
          className={`rounded p-1.5 transition-colors ${
            shuffle ? "text-violet-400 hover:text-violet-300" : "text-neutral-400 hover:text-white"
          }`}
          title={shuffle ? "Shuffle on" : "Shuffle off"}
        >
          <Shuffle size={16} />
        </button>

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

        {/* Expand */}
        <button
          onClick={() => setShowImmersive(true)}
          className="rounded p-1 text-neutral-400 hover:text-white"
          title="Open immersive view"
        >
          <Maximize2 size={14} />
        </button>

        {/* Close */}
        <button onClick={handleStop} className="ml-1 rounded p-1 text-neutral-600 hover:text-white">
          <X size={14} />
        </button>
        </div>
      </div>
    </>
  );
}

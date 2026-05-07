import { create } from "zustand";
import { useDownloadStore } from "./downloadStore";
import { setSetting, getSettings, audioSeek } from "../lib/commands";

export interface PlayerTrack {
  id: string;
  title: string;
  artist?: string;
  filePath: string;
  coverArtBase64?: string;
}

interface PlayerStore {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  volume: number;
  volumeLoaded: boolean;
  currentTime: number;
  duration: number;
  /** Optional ordered playback queue. When set, playNext/playPrev walk this
   * list before falling back to download adjacency. Callers (e.g. LibraryView)
   * pass it to control the listening order. */
  queue: PlayerTrack[];
  /** Stack of previously played tracks. Pushed each time playNext advances. */
  history: PlayerTrack[];
  /** Stack of tracks "rewound from" — populated when playPrev pops history,
   * consumed by playNext so back→forward retraces the same path before
   * resuming queue/shuffle progression. */
  forward: PlayerTrack[];
  shuffle: boolean;
  playTrack: (track: PlayerTrack) => void;
  setQueue: (tracks: PlayerTrack[]) => void;
  toggleShuffle: () => void;
  togglePlayPause: () => void;
  setPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  stop: () => void;
  playNext: () => void;
  playPrev: () => void;
  loadVolume: () => Promise<void>;
}

function downloadQueueIds(): string[] {
  const downloads = useDownloadStore.getState().downloads;
  return downloads
    .filter((d) => d.status === "complete" && d.format === "mp3" && d.filePath)
    .map((d) => d.id);
}

function trackFromDownloadId(id: string): PlayerTrack | null {
  const dl = useDownloadStore.getState().downloads.find((d) => d.id === id);
  if (!dl?.filePath) return null;
  return {
    id: dl.id,
    title: dl.title || "Unknown",
    artist: dl.artist,
    filePath: dl.filePath,
    coverArtBase64: dl.coverArtBase64,
  };
}

/** Resolve the next/previous track relative to `current`. `direction` = +1
 *  for forward, -1 for back. Returns null if there's nowhere to go. */
function resolveAdjacent(
  current: PlayerTrack,
  queue: PlayerTrack[],
  shuffle: boolean,
  direction: 1 | -1,
): PlayerTrack | null {
  if (queue.length > 0) {
    const idx = queue.findIndex((t) => t.id === current.id);
    if (idx >= 0) {
      // Shuffle only applies to forward — "back" should remain deterministic.
      if (direction === 1 && shuffle && queue.length > 1) {
        let pick = idx;
        while (pick === idx) pick = Math.floor(Math.random() * queue.length);
        return queue[pick];
      }
      const nextIdx = idx + direction;
      if (nextIdx >= 0 && nextIdx < queue.length) return queue[nextIdx];
      return null;
    }
  }

  const ids = downloadQueueIds();
  const idx = ids.indexOf(current.id);
  if (idx < 0) return null;
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= ids.length) return null;
  return trackFromDownloadId(ids[nextIdx]);
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  volume: 0.3,
  volumeLoaded: false,
  currentTime: 0,
  duration: 0,
  queue: [],
  history: [],
  forward: [],
  shuffle: false,

  // Manually selecting a track wipes the forward stack — you've branched.
  playTrack: (track) =>
    set({ currentTrack: track, isPlaying: true, currentTime: 0, duration: 0, forward: [] }),

  setQueue: (tracks) => set({ queue: tracks }),

  toggleShuffle: () => {
    const next = !get().shuffle;
    set({ shuffle: next });
    setSetting("shuffle", next ? "1" : "0").catch(() => {});
  },

  togglePlayPause: () => set((s) => ({ isPlaying: !s.isPlaying })),

  setPlaying: (playing) => set({ isPlaying: playing }),

  setVolume: (volume) => {
    set({ volume });
    setSetting("playerVolume", String(volume)).catch(() => {});
  },

  setCurrentTime: (time) => set({ currentTime: time }),

  setDuration: (duration) => set({ duration }),

  stop: () => set({ currentTrack: null, isPlaying: false, currentTime: 0, duration: 0 }),

  loadVolume: async () => {
    if (get().volumeLoaded) return;
    try {
      const settings = await getSettings();
      if (settings.playerVolume != null) {
        const v = parseFloat(settings.playerVolume);
        if (isFinite(v)) set({ volume: v });
      }
      if (settings.shuffle != null) {
        set({ shuffle: settings.shuffle === "1" || settings.shuffle === "true" });
      }
    } catch {}
    set({ volumeLoaded: true });
  },

  playNext: () => {
    const { currentTrack, queue, shuffle, history, forward } = get();
    if (!currentTrack) return;

    // Retrace the forward stack first if we just rewound.
    if (forward.length > 0) {
      const next = forward[forward.length - 1];
      set({
        currentTrack: next,
        isPlaying: true,
        currentTime: 0,
        duration: 0,
        history: [...history, currentTrack],
        forward: forward.slice(0, -1),
      });
      return;
    }

    const next = resolveAdjacent(currentTrack, queue, shuffle, 1);
    if (!next) {
      set({ isPlaying: false });
      return;
    }
    set({
      currentTrack: next,
      isPlaying: true,
      currentTime: 0,
      duration: 0,
      // Only push to history when we walked an explicit queue (so back actually
      // returns somewhere meaningful). Download-adjacency advances stay
      // historyless to match the prior behavior.
      history: queue.some((t) => t.id === currentTrack.id)
        ? [...history, currentTrack]
        : history,
    });
  },

  playPrev: () => {
    const { currentTrack, queue, history, forward, currentTime } = get();
    if (!currentTrack) return;

    // Mid-song "back" restarts the current track; near the start it goes to
    // the previous track. ~3s threshold matches Spotify / Apple Music.
    const RESTART_THRESHOLD_SECS = 3;
    if (currentTime > RESTART_THRESHOLD_SECS) {
      void audioSeek(0);
      set({ currentTime: 0, isPlaying: true });
      return;
    }

    // Prefer the history stack so shuffle "back" returns to the previously
    // played track. Current goes onto forward so next can retrace.
    if (history.length > 0) {
      const prev = history[history.length - 1];
      set({
        currentTrack: prev,
        isPlaying: true,
        currentTime: 0,
        duration: 0,
        history: history.slice(0, -1),
        forward: [...forward, currentTrack],
      });
      return;
    }

    const prev = resolveAdjacent(currentTrack, queue, false, -1);
    if (!prev) return;
    set({
      currentTrack: prev,
      isPlaying: true,
      currentTime: 0,
      duration: 0,
      forward: queue.some((t) => t.id === currentTrack.id)
        ? [...forward, currentTrack]
        : forward,
    });
  },
}));

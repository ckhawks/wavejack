import { create } from "zustand";
import { useDownloadStore } from "./downloadStore";
import { setSetting, getSettings } from "../lib/commands";

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

function getAdjacentMp3s(): string[] {
  const downloads = useDownloadStore.getState().downloads;
  return downloads
    .filter((d) => d.status === "complete" && d.format === "mp3" && d.filePath)
    .map((d) => d.id);
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
      const saved = (settings as any).playerVolume;
      if (saved != null) {
        const v = parseFloat(saved);
        if (isFinite(v)) set({ volume: v });
      }
      const sh = (settings as any).shuffle;
      if (sh != null) set({ shuffle: sh === "1" || sh === "true" });
    } catch {}
    set({ volumeLoaded: true });
  },

  playNext: () => {
    const { currentTrack, queue, shuffle, history, forward } = get();
    if (!currentTrack) return;

    // If we've recently rewound, retrace forward instead of picking anew.
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

    // Try the explicit queue first
    if (queue.length > 0) {
      const idx = queue.findIndex((t) => t.id === currentTrack.id);
      if (idx >= 0) {
        if (shuffle && queue.length > 1) {
          let pick = idx;
          while (pick === idx) {
            pick = Math.floor(Math.random() * queue.length);
          }
          set({
            currentTrack: queue[pick],
            isPlaying: true,
            currentTime: 0,
            duration: 0,
            history: [...history, currentTrack],
          });
          return;
        }
        if (idx < queue.length - 1) {
          set({
            currentTrack: queue[idx + 1],
            isPlaying: true,
            currentTime: 0,
            duration: 0,
            history: [...history, currentTrack],
          });
          return;
        }
        // End of queue
        set({ isPlaying: false });
        return;
      }
    }

    // Fallback: walk the download queue
    const ids = getAdjacentMp3s();
    const idx = ids.indexOf(currentTrack.id);
    if (idx < 0 || idx >= ids.length - 1) {
      set({ isPlaying: false });
      return;
    }
    const nextId = ids[idx + 1];
    const dl = useDownloadStore.getState().downloads.find((d) => d.id === nextId);
    if (dl?.filePath) {
      set({
        currentTrack: {
          id: dl.id,
          title: dl.title || "Unknown",
          artist: dl.artist,
          filePath: dl.filePath,
          coverArtBase64: dl.coverArtBase64,
        },
        isPlaying: true,
        currentTime: 0,
        duration: 0,
      });
    }
  },

  playPrev: () => {
    const { currentTrack, queue, history, forward, currentTime } = get();
    if (!currentTrack) return;

    // Mid-song "back" restarts the current track; near the start it goes to
    // the previous track. ~3s threshold matches Spotify / Apple Music.
    const RESTART_THRESHOLD_SECS = 3;
    if (currentTime > RESTART_THRESHOLD_SECS) {
      const audio = document.querySelector("audio");
      if (audio) audio.currentTime = 0;
      set({ currentTime: 0, isPlaying: true });
      return;
    }

    // Prefer the history stack so shuffle "back" actually returns to the
    // previously played track. The current goes onto the forward stack so
    // pressing next will retrace.
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

    if (queue.length > 0) {
      const idx = queue.findIndex((t) => t.id === currentTrack.id);
      if (idx > 0) {
        set({
          currentTrack: queue[idx - 1],
          isPlaying: true,
          currentTime: 0,
          duration: 0,
          forward: [...forward, currentTrack],
        });
        return;
      }
      if (idx === 0) return;
    }

    const ids = getAdjacentMp3s();
    const idx = ids.indexOf(currentTrack.id);
    if (idx <= 0) return;
    const prevId = ids[idx - 1];
    const dl = useDownloadStore.getState().downloads.find((d) => d.id === prevId);
    if (dl?.filePath) {
      set({
        currentTrack: {
          id: dl.id,
          title: dl.title || "Unknown",
          artist: dl.artist,
          filePath: dl.filePath,
          coverArtBase64: dl.coverArtBase64,
        },
        isPlaying: true,
        currentTime: 0,
        duration: 0,
      });
    }
  },
}));

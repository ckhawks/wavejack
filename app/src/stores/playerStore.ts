import { create } from "zustand";
import { useDownloadStore } from "./downloadStore";
import { setSetting, getSettings, audioSeek } from "../lib/commands";

export interface PlayerTrack {
  id: string;
  title: string;
  artist?: string;
  filePath: string;
  coverArtBase64?: string;
  /** Scanned track length in seconds, when known. Used as the authoritative
   *  seek-bar end-time since the playback engine can't always determine it. */
  durationSecs?: number;
}

interface PlayerStore {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  volume: number;
  volumeLoaded: boolean;
  currentTime: number;
  duration: number;
  /** The playback *context* — the ordered list playback walks by default (e.g.
   * the library list you started from). playNext/playPrev advance through this
   * once the explicit `upNext` queue is empty. */
  queue: PlayerTrack[];
  /** Explicit user queue ("Play next" / "Add to queue"). Always played first,
   * in order, regardless of shuffle. Draining it resumes the context `queue`
   * from wherever it left off. This is what the Up Next panel shows. */
  upNext: PlayerTrack[];
  /** Id of the current position within the context `queue`. Held steady while
   * `upNext` tracks play so the context resumes from the right spot afterward. */
  contextId: string | null;
  /** Stack of previously played tracks. Pushed each time playNext advances. */
  history: PlayerTrack[];
  /** Stack of tracks "rewound from" — populated when playPrev pops history,
   * consumed by playNext so back→forward retraces the same path before
   * resuming queue/shuffle progression. */
  forward: PlayerTrack[];
  shuffle: boolean;
  playTrack: (track: PlayerTrack) => void;
  setQueue: (tracks: PlayerTrack[]) => void;
  /** Put a track at the front of the explicit queue (plays next). */
  queueNext: (track: PlayerTrack) => void;
  /** Append a track to the end of the explicit queue. */
  addToQueue: (track: PlayerTrack) => void;
  /** Jump to a track in the explicit queue by index: play it and drop it plus
   * everything above it, preserving the context anchor for when the rest drains. */
  playQueued: (index: number) => void;
  /** Drop a track from the explicit queue by id. */
  removeFromQueue: (id: string) => void;
  /** Reorder within the explicit queue (drag-to-reorder in the Up Next panel). */
  reorderQueue: (from: number, to: number) => void;
  /** Empty the explicit queue without stopping the current track. */
  clearQueue: () => void;
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
 *  for forward, -1 for back. Returns null if there's nowhere to go.
 *  Exported for unit tests; not part of the store's public surface. */
export function resolveAdjacent(
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

/** Move the element at `from` to `to`, clamping out-of-range indices. Returns a
 *  new array (or the same reference when the move is a no-op). Exported for tests. */
export function reorder<T>(arr: T[], from: number, to: number): T[] {
  if (from < 0 || from >= arr.length || from === to) return arr;
  const clampedTo = Math.max(0, Math.min(to, arr.length - 1));
  if (from === clampedTo) return arr;
  const next = [...arr];
  const [moved] = next.splice(from, 1);
  next.splice(clampedTo, 0, moved);
  return next;
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  volume: 0.3,
  volumeLoaded: false,
  currentTime: 0,
  duration: 0,
  queue: [],
  upNext: [],
  contextId: null,
  history: [],
  forward: [],
  shuffle: false,

  // Manually selecting a track wipes the forward stack — you've branched — and
  // re-anchors the context on this track. The explicit queue is left intact.
  playTrack: (track) =>
    set({
      currentTrack: track,
      contextId: track.id,
      isPlaying: true,
      currentTime: 0,
      duration: 0,
      forward: [],
    }),

  setQueue: (tracks) => set({ queue: tracks }),

  // "Play next": front of the explicit queue. With nothing playing there's no
  // "next" to queue against, so just start it.
  queueNext: (track) => {
    if (!get().currentTrack) {
      get().playTrack(track);
      return;
    }
    set((s) => ({ upNext: [track, ...s.upNext.filter((t) => t.id !== track.id)] }));
  },

  // "Add to queue": tail of the explicit queue.
  addToQueue: (track) => {
    if (!get().currentTrack) {
      get().playTrack(track);
      return;
    }
    set((s) => ({ upNext: [...s.upNext.filter((t) => t.id !== track.id), track] }));
  },

  playQueued: (index) =>
    set((s) => {
      const track = s.upNext[index];
      if (!track) return {};
      return {
        currentTrack: track,
        // Drop the clicked track and any queued ahead of it (they were skipped).
        upNext: s.upNext.slice(index + 1),
        isPlaying: true,
        currentTime: 0,
        duration: 0,
        forward: [],
        history: s.currentTrack ? [...s.history, s.currentTrack] : s.history,
        // contextId is intentionally preserved so the context resumes correctly.
      };
    }),

  removeFromQueue: (id) => set((s) => ({ upNext: s.upNext.filter((t) => t.id !== id) })),

  reorderQueue: (from, to) => set((s) => ({ upNext: reorder(s.upNext, from, to) })),

  clearQueue: () => set({ upNext: [] }),

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
    const { currentTrack, queue, upNext, contextId, shuffle, history, forward } = get();
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

    // The explicit queue always wins, in order, ignoring shuffle. The context
    // anchor (`contextId`) is held so playback resumes there once it drains.
    if (upNext.length > 0) {
      const [next, ...rest] = upNext;
      set({
        currentTrack: next,
        upNext: rest,
        isPlaying: true,
        currentTime: 0,
        duration: 0,
        history: [...history, currentTrack],
      });
      return;
    }

    // Resume the context from where we left off (which may be behind the
    // just-finished explicit-queue track).
    const anchor = queue.find((t) => t.id === contextId) ?? currentTrack;
    const next = resolveAdjacent(anchor, queue, shuffle, 1);
    if (!next) {
      set({ isPlaying: false });
      return;
    }
    set({
      currentTrack: next,
      contextId: next.id,
      isPlaying: true,
      currentTime: 0,
      duration: 0,
      // Only push to history when we walked an explicit context (so back
      // returns somewhere meaningful). Download-adjacency advances stay
      // historyless to match the prior behavior.
      history: queue.some((t) => t.id === anchor.id)
        ? [...history, currentTrack]
        : history,
    });
  },

  playPrev: () => {
    const { currentTrack, queue, contextId, history, forward, currentTime } = get();
    if (!currentTrack) return;

    // Mid-song "back" restarts the current track; near the start it goes to
    // the previous track. ~3s threshold matches Spotify / Apple Music.
    const RESTART_THRESHOLD_SECS = 3;
    if (currentTime > RESTART_THRESHOLD_SECS) {
      void audioSeek(0);
      set({ currentTime: 0, isPlaying: true });
      return;
    }

    // Prefer the history stack so back retraces the actual played sequence
    // (including explicit-queue tracks). Current goes onto forward so next can
    // retrace.
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

    const anchor = queue.find((t) => t.id === contextId) ?? currentTrack;
    const prev = resolveAdjacent(anchor, queue, false, -1);
    if (!prev) return;
    set({
      currentTrack: prev,
      contextId: prev.id,
      isPlaying: true,
      currentTime: 0,
      duration: 0,
      forward: queue.some((t) => t.id === anchor.id)
        ? [...forward, currentTrack]
        : forward,
    });
  },
}));

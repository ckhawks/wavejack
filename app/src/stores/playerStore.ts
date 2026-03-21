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
  playTrack: (track: PlayerTrack) => void;
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

  playTrack: (track) => set({ currentTrack: track, isPlaying: true, currentTime: 0, duration: 0 }),

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
    } catch {}
    set({ volumeLoaded: true });
  },

  playNext: () => {
    const { currentTrack } = get();
    if (!currentTrack) return;
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
    const { currentTrack } = get();
    if (!currentTrack) return;
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

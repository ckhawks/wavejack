import { create } from "zustand";
import type { SeedTrack, DiscoverItem } from "../lib/types";
import {
  discoverSimilar,
  discoverPreview,
  discoverKeep,
  discoverTrash,
  discoverCleanup,
} from "../lib/commands";
import { useSettingsStore } from "./settingsStore";
import { usePlayerStore } from "./playerStore";

/** How many tracks to prefetch ahead of the current index */
const PREFETCH_AHEAD = 2;

interface DiscoverStore {
  seeds: SeedTrack[];
  queue: DiscoverItem[];
  currentIndex: number;
  isLoading: boolean;
  error: string | null;

  addSeed: (seed: SeedTrack) => void;
  removeSeed: (index: number) => void;
  clearSeeds: () => void;
  fetchRecommendations: () => Promise<void>;
  updateItem: (id: string, patch: Partial<DiscoverItem>) => void;
  approveCurrent: () => Promise<void>;
  keepCurrent: () => Promise<void>;
  skipCurrent: () => Promise<void>;
  clearQueue: () => Promise<void>;
  prefetchAhead: () => void;
  playCurrent: () => void;
}

export const useDiscoverStore = create<DiscoverStore>((set, get) => ({
  seeds: [],
  queue: [],
  currentIndex: 0,
  isLoading: false,
  error: null,

  addSeed: (seed) => {
    const { seeds } = get();
    if (seeds.length >= 5) return;
    // Deduplicate
    const exists = seeds.some(
      (s) =>
        s.artist.toLowerCase() === seed.artist.toLowerCase() &&
        s.title.toLowerCase() === seed.title.toLowerCase()
    );
    if (!exists) {
      set({ seeds: [...seeds, seed] });
    }
  },

  removeSeed: (index) =>
    set((s) => ({ seeds: s.seeds.filter((_, i) => i !== index) })),

  clearSeeds: () => set({ seeds: [] }),

  fetchRecommendations: async () => {
    const { seeds } = get();
    if (seeds.length === 0) return;

    const settings = useSettingsStore.getState().settings;

    set({ isLoading: true, error: null });

    try {
      const similar = await discoverSimilar(seeds, settings.lastfmApiKey);

      const items: DiscoverItem[] = similar.map((track) => ({
        id: crypto.randomUUID(),
        title: track.name,
        artist: track.artist,
        matchScore: track.match_score,
        source: track.source,
        status: "pending",
        progress: 0,
        message: "Waiting...",
      }));

      set({ queue: items, currentIndex: 0, isLoading: false });

      // Start prefetching the first few
      get().prefetchAhead();
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as Record<string, unknown>).message)
            : String(e);
      set({ isLoading: false, error: msg });
    }
  },

  updateItem: (id, patch) =>
    set((s) => ({
      queue: s.queue.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    })),

  approveCurrent: async () => {
    const { queue, currentIndex } = get();
    const item = queue[currentIndex];
    if (!item?.filePath) return;
    if (item.message === "Kept!") return;

    try {
      await discoverKeep(item.id, item.filePath);
      get().updateItem(item.id, { message: "Kept!" });
    } catch (e) {
      console.error("Failed to keep track:", e);
    }
  },

  keepCurrent: async () => {
    const { queue, currentIndex } = get();
    const item = queue[currentIndex];
    if (!item?.filePath) return;

    try {
      await discoverKeep(item.id, item.filePath);
      get().updateItem(item.id, { status: "pending", message: "Kept!" });
    } catch (e) {
      console.error("Failed to keep track:", e);
    }

    // Stop playback if this track is playing
    const player = usePlayerStore.getState();
    if (player.currentTrack?.id === item.id) {
      player.stop();
    }

    // Advance
    const nextIndex = currentIndex + 1;
    if (nextIndex < queue.length) {
      set({ currentIndex: nextIndex });
      get().prefetchAhead();
      // Auto-play next if ready
      const next = get().queue[nextIndex];
      if (next?.status === "ready") {
        get().playCurrent();
      }
    }
  },

  skipCurrent: async () => {
    const { queue, currentIndex } = get();
    const item = queue[currentIndex];

    // Stop playback if this track is playing
    const player = usePlayerStore.getState();
    if (player.currentTrack?.id === item?.id) {
      player.stop();
    }

    if (item?.filePath) {
      discoverTrash(item.filePath).catch((e) =>
        console.error("Failed to trash preview:", e)
      );
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < queue.length) {
      set({ currentIndex: nextIndex });
      get().prefetchAhead();
      const next = get().queue[nextIndex];
      if (next?.status === "ready") {
        get().playCurrent();
      }
    }
  },

  clearQueue: async () => {
    usePlayerStore.getState().stop();
    try {
      await discoverCleanup();
    } catch (e) {
      console.error("Failed to cleanup previews:", e);
    }
    set({ queue: [], currentIndex: 0, seeds: [] });
  },

  prefetchAhead: () => {
    const { queue, currentIndex } = get();
    for (let i = currentIndex; i < Math.min(currentIndex + PREFETCH_AHEAD, queue.length); i++) {
      const item = queue[i];
      if (item && item.status === "pending") {
        get().updateItem(item.id, {
          status: "downloading",
          progress: 0,
          message: "Searching & downloading...",
        });
        discoverPreview(item.id, item.title, item.artist).catch((e) =>
          console.error("Failed to start preview download:", e)
        );
      }
    }
  },

  playCurrent: () => {
    const { queue, currentIndex } = get();
    const item = queue[currentIndex];
    if (!item?.filePath || item.status !== "ready") return;

    usePlayerStore.getState().playTrack({
      id: item.id,
      title: item.title,
      artist: item.artist,
      filePath: item.filePath,
      coverArtBase64: item.coverArtBase64,
    });
  },
}));

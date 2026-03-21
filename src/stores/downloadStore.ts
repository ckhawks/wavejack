import { create } from "zustand";
import type { DownloadItem } from "../lib/types";
import {
  getDownloadHistory,
  removeDownloadHistory,
  clearDownloadHistory,
} from "../lib/commands";

interface DownloadStore {
  downloads: DownloadItem[];
  historyLoaded: boolean;
  addDownload: (item: DownloadItem) => void;
  updateDownload: (id: string, patch: Partial<DownloadItem>) => void;
  removeDownload: (id: string) => void;
  clearCompleted: () => void;
  loadHistory: () => Promise<void>;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  downloads: [],
  historyLoaded: false,

  addDownload: (item) =>
    set((state) => ({ downloads: [item, ...state.downloads] })),

  updateDownload: (id, patch) =>
    set((state) => ({
      downloads: state.downloads.map((d) =>
        d.id === id ? { ...d, ...patch } : d
      ),
    })),

  removeDownload: (id) => {
    set((state) => ({
      downloads: state.downloads.filter((d) => d.id !== id),
    }));
    removeDownloadHistory(id).catch((e) =>
      console.error("Failed to remove from DB:", e)
    );
  },

  clearCompleted: () => {
    set((state) => ({
      downloads: state.downloads.filter(
        (d) =>
          d.status !== "complete" &&
          d.status !== "error" &&
          d.status !== "file_missing"
      ),
    }));
    clearDownloadHistory().catch((e) =>
      console.error("Failed to clear DB:", e)
    );
  },

  loadHistory: async () => {
    if (get().historyLoaded) return;
    try {
      const records = await getDownloadHistory();
      const items: DownloadItem[] = records.map((r) => ({
        id: r.id,
        url: r.url,
        format: r.format as "mp4" | "mp3",
        status: r.status as DownloadItem["status"],
        progress: r.status === "complete" || r.status === "file_missing" ? 100 : 0,
        message: r.message,
        backend: r.backend as DownloadItem["backend"],
        title: r.title || undefined,
        artist: r.artist || undefined,
        album: r.album || undefined,
        coverArtBase64: r.cover_art_base64 || undefined,
        filePath: r.file_path || undefined,
        playlistTitle: r.playlist_title || undefined,
      }));
      set((state) => {
        // Merge: keep in-memory items (active downloads), add history items not already present
        const existingIds = new Set(state.downloads.map((d) => d.id));
        const newItems = items.filter((i) => !existingIds.has(i.id));
        return {
          downloads: [...state.downloads, ...newItems],
          historyLoaded: true,
        };
      });
    } catch (e) {
      console.error("Failed to load download history:", e);
      set({ historyLoaded: true });
    }
  },
}));

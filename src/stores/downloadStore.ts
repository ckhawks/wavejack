import { create } from "zustand";
import type { DownloadItem } from "../lib/types";

interface DownloadStore {
  downloads: DownloadItem[];
  addDownload: (item: DownloadItem) => void;
  updateDownload: (id: string, patch: Partial<DownloadItem>) => void;
  removeDownload: (id: string) => void;
  clearCompleted: () => void;
}

export const useDownloadStore = create<DownloadStore>((set) => ({
  downloads: [],

  addDownload: (item) =>
    set((state) => ({ downloads: [item, ...state.downloads] })),

  updateDownload: (id, patch) =>
    set((state) => ({
      downloads: state.downloads.map((d) =>
        d.id === id ? { ...d, ...patch } : d
      ),
    })),

  removeDownload: (id) =>
    set((state) => ({
      downloads: state.downloads.filter((d) => d.id !== id),
    })),

  clearCompleted: () =>
    set((state) => ({
      downloads: state.downloads.filter(
        (d) => d.status !== "complete" && d.status !== "error"
      ),
    })),
}));

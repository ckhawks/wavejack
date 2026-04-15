import { create } from "zustand";
import {
  type LibraryTrack,
  addLibraryFolder,
  getLibraryFolders,
  getLibraryTracks,
  removeLibraryFolder,
  scanLibraryIncremental,
} from "../lib/commands";

interface LibraryStore {
  folders: string[];
  tracks: LibraryTrack[];
  scanning: boolean;
  loaded: boolean;
  searchQuery: string;

  /** Load folders + cached tracks from SQLite, then kick off a background incremental scan. */
  init: () => Promise<void>;
  addFolder: (path: string) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  rescan: () => Promise<void>;
  refresh: () => Promise<void>;
  setSearchQuery: (query: string) => void;
  filteredTracks: () => LibraryTrack[];
}

async function refreshTracks(set: (p: Partial<LibraryStore>) => void) {
  try {
    const tracks = await getLibraryTracks();
    set({ tracks });
  } catch (e) {
    console.error("Failed to load library tracks:", e);
  }
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  folders: [],
  tracks: [],
  scanning: false,
  loaded: false,
  searchQuery: "",

  init: async () => {
    if (get().loaded) return;
    try {
      const [folders, tracks] = await Promise.all([
        getLibraryFolders(),
        getLibraryTracks(),
      ]);
      set({ folders, tracks, loaded: true });
    } catch (e) {
      console.error("Failed to init library:", e);
      set({ loaded: true });
      return;
    }

    // Background incremental scan: find new/changed/missing files without
    // blocking the UI. Reload the cached rows once per folder completes.
    const { folders } = get();
    if (folders.length === 0) return;
    set({ scanning: true });
    for (const folder of folders) {
      try {
        await scanLibraryIncremental(folder);
        await refreshTracks(set);
      } catch (e) {
        console.error(`Incremental scan failed for ${folder}:`, e);
      }
    }
    set({ scanning: false });
  },

  addFolder: async (path) => {
    if (get().folders.includes(path)) return;
    await addLibraryFolder(path);
    set({ folders: [...get().folders, path], scanning: true });
    try {
      await scanLibraryIncremental(path);
      await refreshTracks(set);
    } catch (e) {
      console.error("Failed to scan new folder:", e);
    }
    set({ scanning: false });
  },

  removeFolder: async (path) => {
    await removeLibraryFolder(path);
    set((s) => ({
      folders: s.folders.filter((f) => f !== path),
      tracks: s.tracks.filter((t) => !t.path.startsWith(path)),
    }));
  },

  rescan: async () => {
    const { folders } = get();
    if (folders.length === 0) return;
    set({ scanning: true });
    for (const folder of folders) {
      try {
        await scanLibraryIncremental(folder);
      } catch (e) {
        console.error(`Rescan failed for ${folder}:`, e);
      }
    }
    await refreshTracks(set);
    set({ scanning: false });
  },

  refresh: async () => {
    await refreshTracks(set);
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  filteredTracks: () => {
    const { tracks, searchQuery } = get();
    if (!searchQuery.trim()) return tracks;

    const q = searchQuery.toLowerCase();
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q) ||
        t.filename.toLowerCase().includes(q),
    );
  },
}));

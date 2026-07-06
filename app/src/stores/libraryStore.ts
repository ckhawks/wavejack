import { create } from "zustand";
import {
  type LibraryTrack,
  addLibraryFolder,
  getLibraryFolders,
  getLibraryTracks,
  removeLibraryFolder,
  scanLibraryIncremental,
  getAllTags,
  bulkFetchTags,
} from "../lib/commands";
import type { TagInfo } from "../lib/types";

interface LibraryStore {
  folders: string[];
  tracks: LibraryTrack[];
  scanning: boolean;
  loaded: boolean;
  searchQuery: string;
  tagFilter: string | null;
  allTags: TagInfo[];
  tagFetchProgress: { done: number; total: number } | null;

  /** Load folders + cached tracks from SQLite, then kick off a background incremental scan. */
  init: () => Promise<void>;
  addFolder: (path: string) => Promise<void>;
  removeFolder: (path: string) => Promise<void>;
  rescan: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Patch a single cached track in place (by path) without reloading the whole
   *  library — avoids re-fetching 600+ rows of base64 cover art after one edit. */
  patchTrack: (oldPath: string, updates: Partial<LibraryTrack>) => void;
  setSearchQuery: (query: string) => void;
  setTagFilter: (tag: string | null) => void;
  loadTags: () => Promise<void>;
  startBulkFetchTags: () => Promise<void>;
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
  tagFilter: null,
  allTags: [],
  tagFetchProgress: null,

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

  patchTrack: (oldPath, updates) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.path === oldPath ? { ...t, ...updates } : t)),
    })),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setTagFilter: (tag) => set({ tagFilter: tag }),

  loadTags: async () => {
    try {
      const raw = await getAllTags();
      const allTags: TagInfo[] = raw.map(([id, name, track_count]) => ({
        id, name, track_count,
      }));
      set({ allTags });
    } catch (e) {
      console.error("Failed to load tags:", e);
    }
  },

  startBulkFetchTags: async () => {
    set({ tagFetchProgress: { done: 0, total: 0 } });
    try {
      await bulkFetchTags();
    } catch (e) {
      console.error("Failed to start bulk tag fetch:", e);
      set({ tagFetchProgress: null });
    }
  },

  filteredTracks: () => {
    const { tracks, searchQuery, tagFilter } = get();
    let result = tracks;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q) ||
          t.filename.toLowerCase().includes(q),
      );
    }

    if (tagFilter) {
      result = result.filter((t) => t.tags.includes(tagFilter));
    }

    return result;
  },
}));

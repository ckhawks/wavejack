import { create } from "zustand";
import type { Playlist } from "../lib/types";
import {
  listPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  getPlaylistTracks,
  addToPlaylist,
  removeFromPlaylist,
  reorderPlaylist,
  type LibraryTrack,
} from "../lib/commands";

interface PlaylistStore {
  playlists: Playlist[];
  activePlaylistId: string | null;
  activePlaylistTracks: LibraryTrack[];
  loaded: boolean;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  addTracks: (playlistId: string, paths: string[]) => Promise<void>;
  removeTrack: (playlistId: string, trackPath: string) => Promise<void>;
  reorder: (playlistId: string, paths: string[]) => Promise<void>;
}

export const usePlaylistStore = create<PlaylistStore>((set, get) => ({
  playlists: [],
  activePlaylistId: null,
  activePlaylistTracks: [],
  loaded: false,

  init: async () => {
    if (get().loaded) return;
    const playlists = await listPlaylists();
    set({ playlists, loaded: true });
  },

  refresh: async () => {
    const playlists = await listPlaylists();
    set({ playlists });
    // Refresh active playlist tracks if one is selected
    const { activePlaylistId } = get();
    if (activePlaylistId) {
      const tracks = await getPlaylistTracks(activePlaylistId);
      set({ activePlaylistTracks: tracks });
    }
  },

  create: async (name) => {
    await createPlaylist(name);
    await get().refresh();
  },

  rename: async (id, name) => {
    await renamePlaylist(id, name);
    await get().refresh();
  },

  remove: async (id) => {
    await deletePlaylist(id);
    if (get().activePlaylistId === id) {
      set({ activePlaylistId: null, activePlaylistTracks: [] });
    }
    await get().refresh();
  },

  setActive: async (id) => {
    if (id === null) {
      set({ activePlaylistId: null, activePlaylistTracks: [] });
      return;
    }
    const tracks = await getPlaylistTracks(id);
    set({ activePlaylistId: id, activePlaylistTracks: tracks });
  },

  addTracks: async (playlistId, paths) => {
    await addToPlaylist(playlistId, paths);
    await get().refresh();
  },

  removeTrack: async (playlistId, trackPath) => {
    await removeFromPlaylist(playlistId, trackPath);
    await get().refresh();
  },

  reorder: async (playlistId, paths) => {
    await reorderPlaylist(playlistId, paths);
    await get().refresh();
  },
}));

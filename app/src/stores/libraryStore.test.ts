import { beforeEach, describe, expect, it, vi } from "vitest";

// libraryStore pulls Tauri commands in at module load; stub them so the import
// doesn't reach the IPC layer. The selector under test touches none of them.
vi.mock("../lib/commands", () => ({
  addLibraryFolder: vi.fn(),
  getLibraryFolders: vi.fn(),
  getLibraryTracks: vi.fn(),
  removeLibraryFolder: vi.fn(),
  scanLibraryIncremental: vi.fn(),
  getAllTags: vi.fn(),
  bulkFetchTags: vi.fn(),
}));

import { useLibraryStore } from "./libraryStore";
import type { LibraryTrack } from "../lib/commands";

const makeTrack = (over: Partial<LibraryTrack>): LibraryTrack => ({
  path: "/music/x.mp3",
  filename: "x.mp3",
  title: "Title",
  artist: "Artist",
  album: "Album",
  duration_secs: 180,
  cover_art_base64: "",
  first_scanned_at: 0,
  bitrate_kbps: 320,
  bitrate_estimated: false,
  play_count: 0,
  last_played_at: 0,
  tags: [],
  file_type: "MP3",
  ...over,
});

const strobe = makeTrack({ path: "/m/1.mp3", filename: "strobe.mp3", title: "Strobe", artist: "deadmau5", tags: ["Techno"] });
const ghosts = makeTrack({ path: "/m/2.mp3", filename: "ghosts.mp3", title: "Ghosts n Stuff", artist: "deadmau5", tags: ["Electro"] });
const opus = makeTrack({ path: "/m/3.mp3", filename: "nocturne.flac", title: "Nocturne", artist: "Chopin", album: "Night", tags: ["Classical"] });

describe("libraryStore.filteredTracks", () => {
  beforeEach(() => {
    useLibraryStore.setState({ tracks: [strobe, ghosts, opus], searchQuery: "", tagFilter: null });
  });

  it("returns all tracks when there is no filter", () => {
    expect(useLibraryStore.getState().filteredTracks()).toHaveLength(3);
  });

  it("matches the search query case-insensitively across title/artist/album/filename", () => {
    useLibraryStore.setState({ searchQuery: "DEADMAU5" });
    expect(useLibraryStore.getState().filteredTracks()).toEqual([strobe, ghosts]);

    useLibraryStore.setState({ searchQuery: "night" }); // album match
    expect(useLibraryStore.getState().filteredTracks()).toEqual([opus]);

    useLibraryStore.setState({ searchQuery: "nocturne.flac" }); // filename match
    expect(useLibraryStore.getState().filteredTracks()).toEqual([opus]);
  });

  it("filters by exact tag membership", () => {
    useLibraryStore.setState({ tagFilter: "Classical" });
    expect(useLibraryStore.getState().filteredTracks()).toEqual([opus]);
  });

  it("applies search and tag filters together (AND)", () => {
    useLibraryStore.setState({ searchQuery: "deadmau5", tagFilter: "Techno" });
    expect(useLibraryStore.getState().filteredTracks()).toEqual([strobe]);
  });

  it("ignores a whitespace-only search query", () => {
    useLibraryStore.setState({ searchQuery: "   " });
    expect(useLibraryStore.getState().filteredTracks()).toHaveLength(3);
  });
});

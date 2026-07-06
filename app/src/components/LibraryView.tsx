import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import {
  FolderPlus,
  RefreshCw,
  Search,
  Music,
  Play,
  X,
  Save,
  Image as ImageIcon,
  Loader,
  Check,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  SplitSquareHorizontal,
  Dices,
  ListMusic,
  Wrench,
  PanelLeftOpen,
  Folder,
  ChevronRight,
  Tag,
  FileCog,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useDiscoverStore } from "../stores/discoverStore";
import { usePlaylistStore } from "../stores/playlistStore";
import { useNavStore } from "../stores/navStore";
import { MetadataPicker } from "./MetadataPicker";
import { PlaylistSidebar } from "./library/PlaylistSidebar";
import { TagFilterBar } from "./library/TagFilterBar";
import { AddToPlaylistMenu } from "./library/AddToPlaylistMenu";
import { TrackActionsMenu } from "./library/TrackActionsMenu";
import {
  applyLibraryMetadata,
  updateLibraryTrack,
  bulkParseLibraryTracks,
  fixLibraryExtensions,
  findCoverCandidate,
  embedCoverArt,
  type LibraryTrack,
  type CoverCandidate,
  type BulkParseEdit,
} from "../lib/commands";

type SortField = "title" | "artist" | "album" | "duration" | "bitrate" | "fileType" | "added" | "plays" | "lastPlayed" | "random";
type SortDir = "asc" | "desc";
type ColumnKey = "artist" | "album" | "duration" | "bitrate" | "fileType" | "added" | "plays" | "lastPlayed" | "tags";

const DEFAULT_COLUMNS: Record<ColumnKey, boolean> = {
  artist: false,
  album: true,
  duration: true,
  bitrate: false,
  fileType: true,
  added: true,
  plays: false,
  lastPlayed: false,
  tags: true,
};
const DEFAULT_SORT: { field: SortField; dir: SortDir } = { field: "artist", dir: "asc" };

const COLUMN_LABELS: Record<ColumnKey, string> = {
  artist: "Artist (separate column)",
  album: "Album",
  duration: "Length",
  bitrate: "Bitrate",
  fileType: "Type",
  added: "Added",
  plays: "Play count",
  lastPlayed: "Last played",
  tags: "Tags",
};

function relativeTime(unixSecs: number): string {
  if (!unixSecs) return "—";
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function absoluteDate(unixSecs: number): string {
  if (!unixSecs) return "";
  return new Date(unixSecs * 1000).toLocaleString();
}

function formatDuration(secs: number): string {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Heuristic for "metadata needs fixing": empty artist OR title contains " - "
 * (almost always an unparsed "Artist - Title" filename). */
/** Strip a yt-dlp-style YouTube ID suffix (" [11 chars]"), optionally followed
 * by a file extension. YT IDs are exactly 11 chars from [A-Za-z0-9_-]. */
const YT_ID_SUFFIX = /\s*\[[A-Za-z0-9_-]{11}\](?=\.[^.]+$|$)/;
function stripYoutubeId(s: string): string {
  return s.replace(YT_ID_SUFFIX, "");
}

function needsMetadataFix(t: LibraryTrack): boolean {
  if (!t.artist?.trim()) return true;
  if (t.title && t.title.includes(" - ")) return true;
  if (t.title && YT_ID_SUFFIX.test(t.title)) return true;
  return false;
}

/** Split "Artist - Title" into parts. Returns null if no clean " - " split exists. */
function parseArtistTitle(source: string): { artist: string; title: string } | null {
  // Strip extension and any trailing YT ID before splitting.
  const noExt = source.replace(/\.[^./\\]+$/, "");
  const stem = stripYoutubeId(noExt).trim();
  const idx = stem.indexOf(" - ");
  if (idx <= 0 || idx >= stem.length - 3) return null;
  const artist = stem.slice(0, idx).trim();
  const title = stem.slice(idx + 3).trim();
  if (!artist || !title) return null;
  return { artist, title };
}

/** Pick the best source string to parse for a track — prefer a title that
 * already contains " - " (that's what's wrong), else fall back to the filename. */
function pickParseSource(t: LibraryTrack): string {
  if (t.title && t.title.includes(" - ")) return t.title;
  return t.filename || "";
}

/** Extensions each content type may legitimately carry (mirrors the backend's
 * type_info map). Used to flag files whose extension lies about their content. */
const TYPE_EXTENSIONS: Record<string, string[]> = {
  MP3: ["mp3"],
  FLAC: ["flac"],
  M4A: ["m4a", "mp4", "m4b", "m4p"],
  Opus: ["opus", "ogg"],
  OGG: ["ogg", "oga"],
  WAV: ["wav", "wave"],
  AIFF: ["aiff", "aif", "aifc"],
  AAC: ["aac"],
  WavPack: ["wv"],
  APE: ["ape"],
  Speex: ["spx", "ogg"],
};

/** True when the track's real (content-detected) type doesn't match its
 * filename extension — i.e. a mislabeled file the fix tool would rename. */
function typeMismatch(t: LibraryTrack): boolean {
  if (!t.file_type) return false;
  const ext = t.filename.split(".").pop()?.toLowerCase();
  const accepted = TYPE_EXTENSIONS[t.file_type];
  if (!ext || !accepted) return false;
  return !accepted.includes(ext);
}

export function LibraryView() {
  const { folders, tracks, scanning, searchQuery, addFolder, removeFolder, rescan, refresh, setSearchQuery, filteredTracks } = useLibraryStore();
  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.filePath);
  const settings = useSettingsStore((s) => s.settings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [showPlaylists, setShowPlaylists] = useState(true);
  const activePlaylistId = usePlaylistStore((s) => s.activePlaylistId);
  const activePlaylistTracks = usePlaylistStore((s) => s.activePlaylistTracks);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const setTagFilter = useLibraryStore((s) => s.setTagFilter);
  const loadTags = useLibraryStore((s) => s.loadTags);
  const tagFetchProgress = useLibraryStore((s) => s.tagFetchProgress);
  const startBulkFetchTags = useLibraryStore((s) => s.startBulkFetchTags);

  // Init playlists + tags on mount
  useEffect(() => {
    usePlaylistStore.getState().init();
    loadTags();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for tag-fetch-progress events
  useEffect(() => {
    const unlisten = listen<{ done: number; total: number; finished?: boolean }>(
      "tag-fetch-progress",
      (e) => {
        const { done, total, finished } = e.payload;
        if (finished) {
          useLibraryStore.setState({ tagFetchProgress: null });
          // Reload tracks + tags to reflect new data
          useLibraryStore.getState().refresh();
          loadTags();
        } else {
          useLibraryStore.setState({ tagFetchProgress: { done, total } });
        }
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [loadTags]);

  // Multi-select state
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastClickedPath = useRef<string | null>(null);
  const displayedRef = useRef<typeof tracks>([]);

  const handleRowClick = useCallback((path: string, e: React.MouseEvent) => {
    // Don't select if clicking a button/input inside the row
    if ((e.target as HTMLElement).closest("button, input, a")) return;

    const tracks = displayedRef.current;
    const shiftKey = e.shiftKey;
    const ctrlKey = e.ctrlKey || e.metaKey;

    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastClickedPath.current) {
        // Shift-click: select range between last clicked and current
        let startIdx = -1;
        let endIdx = -1;
        for (let i = 0; i < tracks.length; i++) {
          if (tracks[i].path === lastClickedPath.current) startIdx = i;
          if (tracks[i].path === path) endIdx = i;
        }
        if (startIdx >= 0 && endIdx >= 0) {
          const lo = Math.min(startIdx, endIdx);
          const hi = Math.max(startIdx, endIdx);
          for (let i = lo; i <= hi; i++) {
            next.add(tracks[i].path);
          }
        }
      } else if (ctrlKey) {
        // Ctrl/Cmd-click: toggle single
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else {
        // Plain click: select only this, or deselect if already sole selection
        if (next.size === 1 && next.has(path)) {
          next.clear();
        } else {
          next.clear();
          next.add(path);
        }
      }
      return next;
    });
    // Only update anchor on non-shift clicks
    if (!e.shiftKey) {
      lastClickedPath.current = path;
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    lastClickedPath.current = null;
  }, []);

  const [showFolders, setShowFolders] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [needsFixOnly, setNeedsFixOnly] = useState(false);
  const [editing, setEditing] = useState<LibraryTrack | null>(null);
  const [manualEdit, setManualEdit] = useState<LibraryTrack | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editAlbum, setEditAlbum] = useState("");
  const [editFilename, setEditFilename] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>("");
  const [findingArtFor, setFindingArtFor] = useState<string | null>(null);
  const [bulkArt, setBulkArt] = useState<{ done: number; total: number } | null>(null);
  const [bulkParse, setBulkParse] = useState<{ done: number; total: number; current: string } | null>(null);
  const [fixExt, setFixExt] = useState<{ done: number; total: number; current: string; fixed: number } | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<
    Array<{ track: LibraryTrack; candidate: CoverCandidate }>
  >([]);

  const columns = useMemo<Record<ColumnKey, boolean>>(() => {
    try {
      return { ...DEFAULT_COLUMNS, ...JSON.parse(settings.libraryColumns || "{}") };
    } catch {
      return DEFAULT_COLUMNS;
    }
  }, [settings.libraryColumns]);

  const sort = useMemo<{ field: SortField; dir: SortDir; seed?: number }>(() => {
    try {
      return { ...DEFAULT_SORT, ...JSON.parse(settings.librarySort || "{}") };
    } catch {
      return DEFAULT_SORT;
    }
  }, [settings.librarySort]);

  /** Cheap deterministic 32-bit hash so a (path, seed) pair maps to a stable
   * pseudo-random number. Used to keep the random-sort order stable across
   * re-renders until the user reshuffles. */
  const hash32 = (s: string, seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };

  const reshuffle = () => {
    void updateSetting(
      "librarySort",
      JSON.stringify({ field: "random", dir: "asc", seed: Math.floor(Math.random() * 0xffffffff) }),
    );
  };

  const setColumn = (key: ColumnKey, visible: boolean) => {
    void updateSetting("libraryColumns", JSON.stringify({ ...columns, [key]: visible }));
  };

  const handleSortClick = (field: SortField) => {
    const next: { field: SortField; dir: SortDir } =
      sort.field === field
        ? { field, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { field, dir: "asc" };
    void updateSetting("librarySort", JSON.stringify(next));
  };

  const filtered = activePlaylistId ? activePlaylistTracks : filteredTracks();

  const displayed = useMemo(() => {
    const base = needsFixOnly ? filtered.filter(needsMetadataFix) : filtered;
    const arr = [...base];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sort.field) {
        case "title":
          cmp = (a.title || "").localeCompare(b.title || "");
          break;
        case "artist":
          cmp =
            (a.artist || "").localeCompare(b.artist || "") ||
            (a.album || "").localeCompare(b.album || "") ||
            (a.title || "").localeCompare(b.title || "");
          break;
        case "album":
          cmp =
            (a.album || "").localeCompare(b.album || "") ||
            (a.title || "").localeCompare(b.title || "");
          break;
        case "duration":
          cmp = a.duration_secs - b.duration_secs;
          break;
        case "bitrate":
          cmp = a.bitrate_kbps - b.bitrate_kbps;
          break;
        case "fileType":
          cmp =
            (a.file_type || "").localeCompare(b.file_type || "") ||
            (a.title || "").localeCompare(b.title || "");
          break;
        case "added":
          cmp = a.first_scanned_at - b.first_scanned_at;
          break;
        case "plays":
          cmp = a.play_count - b.play_count;
          break;
        case "lastPlayed":
          cmp = a.last_played_at - b.last_played_at;
          break;
        case "random": {
          const seed = sort.seed ?? 1;
          cmp = hash32(a.path, seed) - hash32(b.path, seed);
          break;
        }
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort, needsFixOnly]);
  displayedRef.current = displayed;

  // Clear selection when the underlying data changes (sort, filter, search)
  // Track by a stable key rather than the array reference itself.
  const displayedKey = `${sort.field}:${sort.dir}:${searchQuery}:${tagFilter}:${needsFixOnly}:${activePlaylistId}:${displayed.length}`;
  const prevDisplayedKey = useRef(displayedKey);
  useEffect(() => {
    if (prevDisplayedKey.current !== displayedKey) {
      prevDisplayedKey.current = displayedKey;
      clearSelection();
    }
  }, [displayedKey, clearSelection]);

  const fixCount = useMemo(() => filtered.filter(needsMetadataFix).length, [filtered]);

  /** If the just-updated track is currently playing, refresh its cover art on the player row. */
  const syncPlayerCoverIfPlaying = (path: string, base64: string) => {
    const player = usePlayerStore.getState();
    if (player.currentTrack?.filePath === path) {
      usePlayerStore.setState({
        currentTrack: { ...player.currentTrack, coverArtBase64: base64 },
      });
    }
  };

  const sourceLabel = (s: CoverCandidate["source"]): string => {
    if (s === "music_brainz") return "MusicBrainz";
    if (s === "download_history") return "Original source";
    return "YouTube search";
  };

  const handleFindArt = async (track: LibraryTrack) => {
    setFindingArtFor(track.path);
    try {
      const candidate = await findCoverCandidate(track.path, track.title, track.artist, true);
      if (!candidate) return;
      if (candidate.source === "music_brainz" || candidate.source === "download_history") {
        await embedCoverArt(track.path, candidate.image_base64);
        syncPlayerCoverIfPlaying(track.path, candidate.image_base64);
        await refresh();
      } else {
        setPendingApprovals((q) => [...q, { track, candidate }]);
      }
    } catch (e) {
      console.error("Failed to find cover art:", e);
    } finally {
      setFindingArtFor(null);
    }
  };

  const handleBulkFindArt = async () => {
    const targets = displayed.filter((t) => !t.cover_art_base64);
    if (targets.length === 0) return;
    setBulkArt({ done: 0, total: targets.length });
    const queue: Array<{ track: LibraryTrack; candidate: CoverCandidate }> = [];
    for (let i = 0; i < targets.length; i++) {
      const track = targets[i];
      try {
        const candidate = await findCoverCandidate(track.path, track.title, track.artist, false);
        if (candidate) {
          await embedCoverArt(track.path, candidate.image_base64);
          syncPlayerCoverIfPlaying(track.path, candidate.image_base64);
        } else {
          const fallback = await findCoverCandidate(track.path, track.title, track.artist, true);
          if (fallback) queue.push({ track, candidate: fallback });
        }
      } catch (e) {
        console.error("Bulk cover art failed for", track.path, e);
      }
      setBulkArt({ done: i + 1, total: targets.length });
    }
    await refresh();
    setBulkArt(null);
    if (queue.length > 0) setPendingApprovals((q) => [...q, ...queue]);
  };

  const approveCandidate = async (idx: number) => {
    const item = pendingApprovals[idx];
    try {
      await embedCoverArt(item.track.path, item.candidate.image_base64);
      syncPlayerCoverIfPlaying(item.track.path, item.candidate.image_base64);
      await refresh();
    } catch (e) {
      console.error("Failed to embed approved cover:", e);
    }
    setPendingApprovals((q) => q.filter((_, i) => i !== idx));
  };

  const rejectCandidate = (idx: number) => {
    setPendingApprovals((q) => q.filter((_, i) => i !== idx));
  };

  const handleAddFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await addFolder(selected as string);
    }
  };

  const handlePlay = (track: LibraryTrack) => {
    // Push the current displayed order into the player as the queue, so when
    // the track ends the player can advance to whatever's next in the user's
    // sorted/filtered list.
    usePlayerStore.getState().setQueue(
      displayed.map((t) => ({
        id: t.path,
        title: t.title,
        artist: t.artist,
        filePath: t.path,
        coverArtBase64: t.cover_art_base64 || undefined,
      }))
    );
    playTrack({
      id: track.path,
      title: track.title,
      artist: track.artist,
      filePath: track.path,
      coverArtBase64: track.cover_art_base64 || undefined,
    });
  };

  const handleDiscoverSimilar = (track: LibraryTrack) => {
    const store = useDiscoverStore.getState();
    store.clearSeeds();
    store.addSeed({ title: track.title, artist: track.artist });
    store.fetchRecommendations();
    useNavStore.getState().setActiveTab("discover");
  };

  const startManualEdit = (track: LibraryTrack) => {
    setManualEdit(track);
    setEditTitle(track.title || "");
    setEditArtist(track.artist || "");
    setEditAlbum(track.album || "");
    setEditFilename(track.filename || "");
  };

  // Derived, read-only filename preview in the modal.
  const sanitizeForFilename = (s: string) =>
    s.replace(/[<>:"/\\|?*]/g, "_");
  const previewFilename = (() => {
    if (!manualEdit) return "";
    const ext = (manualEdit.filename.match(/\.[^./\\]+$/) || [""])[0];
    if (!editArtist.trim() || !editTitle.trim()) return manualEdit.filename;
    return `${sanitizeForFilename(editArtist.trim())} - ${sanitizeForFilename(editTitle.trim())}${ext}`;
  })();

  const handleParseInModal = () => {
    const candidates = [editFilename, manualEdit?.title || "", manualEdit?.filename || ""];
    for (const c of candidates) {
      const parsed = parseArtistTitle(c);
      if (parsed) {
        setEditArtist(parsed.artist);
        setEditTitle(parsed.title);
        return;
      }
    }
  };

  const handleBulkParse = async () => {
    // Compute every edit up front, then hand the whole batch to the backend,
    // which rewrites tags + renames files concurrently (far faster than one
    // awaited IPC round-trip per track) and streams progress events back.
    const edits: BulkParseEdit[] = [];
    for (const t of displayed) {
      if (!needsMetadataFix(t)) continue;
      const parsed = parseArtistTitle(pickParseSource(t));
      if (parsed) {
        edits.push({ path: t.path, title: parsed.title, artist: parsed.artist, album: t.album || "" });
      } else if (t.title && YT_ID_SUFFIX.test(t.title)) {
        // No parseable split — just clean the YT ID from the title.
        const cleaned = stripYoutubeId(t.title).trim();
        if (cleaned && cleaned !== t.title) {
          edits.push({ path: t.path, title: cleaned, artist: t.artist || "", album: t.album || "" });
        }
      }
    }
    if (edits.length === 0) return;

    setBulkParse({ done: 0, total: edits.length, current: "" });
    const unlisten = await listen<{ done: number; total: number; current: string }>(
      "library-bulk-parse-progress",
      (e) => setBulkParse(e.payload),
    );
    try {
      await bulkParseLibraryTracks(edits);
    } catch (e) {
      console.error("Bulk parse failed:", e);
    } finally {
      unlisten();
    }
    await refresh();
    setBulkParse(null);
  };

  const handleFixExtensions = async () => {
    if (tracks.length === 0) return;
    setFixExt({ done: 0, total: tracks.length, current: "", fixed: 0 });
    const unlisten = await listen<{ done: number; total: number; current: string; fixed: number }>(
      "library-fix-ext-progress",
      (e) => setFixExt(e.payload),
    );
    try {
      await fixLibraryExtensions();
    } catch (e) {
      console.error("Fix extensions failed:", e);
    } finally {
      unlisten();
    }
    await refresh();
    setFixExt(null);
  };

  const handleSaveManual = async () => {
    if (!manualEdit) return;
    setSaving(true);
    setSaveError("");
    try {
      const newPath = await updateLibraryTrack(manualEdit.path, editTitle, editArtist, editAlbum, editFilename);
      // Patch just this row instead of reloading the whole library (600+ rows of
      // base64 cover art). The backend renames to "{artist} - {title}.{ext}".
      const filename = newPath.split(/[/\\]/).pop() || manualEdit.filename;
      useLibraryStore.getState().patchTrack(manualEdit.path, {
        path: newPath,
        filename,
        title: editTitle,
        artist: editArtist,
        album: editAlbum,
      });
      setManualEdit(null);
    } catch (e: unknown) {
      const raw = e as { message?: string } | string | undefined;
      const msg = typeof raw === "string" ? raw : raw?.message ?? JSON.stringify(e);
      console.error("Failed to save metadata:", e);
      const hint = msg.toLowerCase().includes("file not found")
        ? " — the cached row is stale. Click Rescan to clean it up."
        : "";
      setSaveError(msg + hint);
    } finally {
      setSaving(false);
    }
  };

  const SortHeader = ({ field, label, className = "" }: { field: SortField; label: string; className?: string }) => {
    const active = sort.field === field;
    return (
      <th className={`py-2 ${className}`}>
        <button
          onClick={() => handleSortClick(field)}
          className={`flex items-center gap-1 text-[10px] uppercase tracking-wider transition-colors ${
            active ? "text-neutral-300" : "text-neutral-600 hover:text-neutral-400"
          }`}
        >
          {label}
          {active && (sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
        </button>
      </th>
    );
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Playlist sidebar */}
      {showPlaylists && <PlaylistSidebar onCollapse={() => setShowPlaylists(false)} />}

      <div className="flex flex-1 flex-col gap-4 overflow-hidden pt-6">
      {/* Header (padded so it doesn't kiss the window edges) */}
      <div className="flex items-center gap-2 px-6">
        {!showPlaylists && (
          <button
            onClick={() => setShowPlaylists(true)}
            className="flex items-center justify-center rounded bg-[#222] px-2 py-2 text-xs text-neutral-400 hover:bg-[#333] hover:text-white"
            title="Show playlists"
          >
            <PanelLeftOpen size={14} />
          </button>
        )}
        <div className="flex flex-1 items-center gap-2 rounded bg-[#111] px-3 py-2 ring-1 ring-[#333] focus-within:ring-[#555]">
          <Search size={14} className="text-neutral-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search library..."
            className="flex-1 bg-transparent text-xs text-white outline-none"
          />
        </div>
        <button
          onClick={handleAddFolder}
          className="flex items-center gap-1.5 rounded bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500"
        >
          <FolderPlus size={14} />
          Add Folder
        </button>
        {bulkArt && (
          <div className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300" title="Finding album art">
            <Loader size={14} className="animate-spin" />
            <ImageIcon size={12} className="text-neutral-500" />
            {bulkArt.done}/{bulkArt.total}
          </div>
        )}
        {bulkParse && (
          <div
            className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300"
            title={bulkParse.current ? `Parsing: ${bulkParse.current}` : "Parsing names"}
          >
            <Loader size={14} className="animate-spin" />
            <SplitSquareHorizontal size={12} className="text-neutral-500" />
            <span className="tabular-nums">{bulkParse.done}/{bulkParse.total}</span>
            {bulkParse.current && (
              <span className="max-w-[220px] truncate text-neutral-500">{bulkParse.current}</span>
            )}
          </div>
        )}
        {fixExt && (
          <div
            className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300"
            title={fixExt.current ? `Checking: ${fixExt.current}` : "Fixing extensions"}
          >
            <Loader size={14} className="animate-spin" />
            <FileCog size={12} className="text-neutral-500" />
            <span className="tabular-nums">{fixExt.done}/{fixExt.total}</span>
            <span className="text-neutral-500">· {fixExt.fixed} fixed</span>
          </div>
        )}
        {tagFetchProgress && (
          <div className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300" title="Fetching tags">
            <Loader size={14} className="animate-spin" />
            <Tag size={12} className="text-neutral-500" />
            {tagFetchProgress.done}/{tagFetchProgress.total}
          </div>
        )}
        <div className="relative">
          <button
            onClick={() => setShowToolsMenu((v) => !v)}
            className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs ${
              needsFixOnly
                ? "bg-violet-600/20 text-violet-300 ring-1 ring-violet-500/40"
                : "bg-[#222] text-neutral-300 hover:bg-[#333]"
            }`}
            title="Library tools"
          >
            <Wrench size={14} />
            Tools
          </button>
          {showToolsMenu && (
            <div
              className="absolute right-0 top-full z-30 mt-1 max-h-[80vh] min-w-[240px] overflow-y-auto rounded border border-[#333] bg-[#0a0a0a] py-1 shadow-xl"
              onMouseLeave={() => setShowToolsMenu(false)}
            >
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Library
              </div>
              <button
                onClick={() => { void rescan(); setShowToolsMenu(false); }}
                disabled={scanning || folders.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-40"
              >
                <RefreshCw size={12} className={scanning ? "animate-spin" : ""} />
                Rescan folders
              </button>
              <button
                onClick={() => { void handleBulkFindArt(); setShowToolsMenu(false); }}
                disabled={!!bulkArt || tracks.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-40"
              >
                <ImageIcon size={12} />
                Find missing art
              </button>
              <button
                onClick={() => { void handleBulkParse(); setShowToolsMenu(false); }}
                disabled={!!bulkParse || tracks.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-40"
              >
                <SplitSquareHorizontal size={12} />
                Parse "Artist - Title" from filenames
              </button>
              <button
                onClick={() => { void handleFixExtensions(); setShowToolsMenu(false); }}
                disabled={!!fixExt || tracks.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-40"
                title="Rename files whose extension doesn't match their real audio format (e.g. AAC saved as .mp3)"
              >
                <FileCog size={12} />
                Fix mislabeled extensions
              </button>
              <button
                onClick={() => { void startBulkFetchTags(); setShowToolsMenu(false); }}
                disabled={!!tagFetchProgress || tracks.length === 0}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-40"
                title="Fetch genre tags from Last.fm"
              >
                <Tag size={12} />
                Fetch genre tags (Last.fm)
              </button>

              <div className="mx-2 my-1 border-t border-[#222]" />
              <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                View
              </div>
              <button
                onClick={() => setNeedsFixOnly((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
              >
                <AlertTriangle size={12} className={needsFixOnly ? "text-yellow-400" : ""} />
                <span className="flex-1">Needs fix only ({fixCount})</span>
                {needsFixOnly && <Check size={12} className="text-yellow-400" />}
              </button>

              <div className="mx-2 my-1 border-t border-[#222]" />
              <div className="px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-neutral-600">
                Columns
              </div>
              {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs text-neutral-300 hover:bg-[#1a1a1a]"
                >
                  <input
                    type="checkbox"
                    checked={columns[key]}
                    onChange={(e) => setColumn(key, e.target.checked)}
                  />
                  {COLUMN_LABELS[key]}
                </label>
              ))}

              <div className="mx-2 my-1 border-t border-[#222]" />
              <button
                onClick={() => { setShowFolders(true); setShowToolsMenu(false); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
              >
                <Folder size={12} />
                <span className="flex-1">Manage folders ({folders.length})</span>
                <ChevronRight size={12} className="text-neutral-600" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Folder management modal */}
      {showFolders && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-lg space-y-3 rounded-lg border border-[#333] bg-[#0a0a0a] p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-white">Manage folders</p>
              <button onClick={() => setShowFolders(false)} className="text-neutral-500 hover:text-white">
                <X size={14} />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {folders.length === 0 ? (
                <p className="rounded border border-dashed border-[#333] px-3 py-4 text-center text-xs text-neutral-500">
                  No folders added yet. Add one to scan your music.
                </p>
              ) : (
                folders.map((f) => (
                  <div key={f} className="flex items-center justify-between rounded px-2 py-1 hover:bg-[#1a1a1a]">
                    <span className="truncate text-xs text-neutral-300" title={f}>{f}</span>
                    <button
                      onClick={() => { void removeFolder(f); }}
                      className="ml-2 text-neutral-600 hover:text-red-400"
                      title="Remove folder"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowFolders(false)}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-[#222] hover:text-white"
              >
                Close
              </button>
              <button
                onClick={handleAddFolder}
                className="flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500"
              >
                <FolderPlus size={12} />
                Add folder
              </button>
            </div>
          </div>
        </div>
      )}

      {tracks.length > 0 && <TagFilterBar />}

      {/* Bulk selection bar */}
      {selectedPaths.size > 0 && (
        <div className="flex items-center gap-3 bg-violet-600/10 px-6 py-2 ring-1 ring-inset ring-violet-500/20">
          <span className="text-xs font-medium text-violet-300">
            {selectedPaths.size} selected
          </span>
          <button
            onClick={clearSelection}
            className="text-xs text-neutral-500 hover:text-white"
          >
            Clear
          </button>
          <div className="ml-auto flex items-center gap-2">
            {usePlaylistStore.getState().playlists.map((p) => (
              <button
                key={p.id}
                onClick={async () => {
                  await usePlaylistStore.getState().addTracks(p.id, [...selectedPaths]);
                  clearSelection();
                }}
                className="flex items-center gap-1 rounded bg-[#222] px-2.5 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-[#333] hover:text-white"
              >
                <ListMusic size={10} />
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="px-6 text-xs text-neutral-500">
        {scanning ? "Scanning..." : `${tracks.length} tracks`}
        {(searchQuery || needsFixOnly || tagFilter || activePlaylistId) && ` (${displayed.length} shown)`}
      </div>

      {/* Cover art approval queue */}
      {pendingApprovals.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-md space-y-4 rounded-lg border border-[#333] bg-[#0a0a0a] p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-white">
                Review cover art ({pendingApprovals.length} remaining)
              </p>
              <button onClick={() => setPendingApprovals([])} className="text-neutral-500 hover:text-white" title="Discard all">
                <X size={14} />
              </button>
            </div>
            {(() => {
              const { track, candidate } = pendingApprovals[0];
              return (
                <>
                  <div className="flex justify-center">
                    <img
                      src={`data:image/jpeg;base64,${candidate.image_base64}`}
                      alt=""
                      className="h-64 w-64 rounded object-cover"
                    />
                  </div>
                  <div className="text-center">
                    <p className="truncate text-sm text-white">{track.title || track.filename}</p>
                    <p className="truncate text-xs text-neutral-400">{track.artist || "—"}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wider text-neutral-600">
                      via {sourceLabel(candidate.source)}
                    </p>
                  </div>
                  <div className="flex justify-center gap-2">
                    <button
                      onClick={() => rejectCandidate(0)}
                      className="flex items-center gap-1 rounded-md border border-[#333] px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:border-[#555] hover:text-white"
                    >
                      <X size={12} />
                      Skip
                    </button>
                    <button
                      onClick={() => approveCandidate(0)}
                      className="flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-neutral-200"
                    >
                      <Check size={12} />
                      Use this
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Manual metadata edit modal */}
      {manualEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-lg space-y-3 rounded-lg border border-[#333] bg-[#0a0a0a] p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-white">Edit metadata</p>
              <button onClick={() => { setManualEdit(null); setSaveError(""); }} className="text-neutral-500 hover:text-white">
                <X size={14} />
              </button>
            </div>
            <p className="truncate text-xs text-neutral-500" title={manualEdit.path}>
              {manualEdit.path}
            </p>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              placeholder="Title"
              className="w-full rounded border border-[#333] bg-[#111] px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
            />
            <input
              type="text"
              value={editArtist}
              onChange={(e) => setEditArtist(e.target.value)}
              placeholder="Artist"
              className="w-full rounded border border-[#333] bg-[#111] px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
            />
            <input
              type="text"
              value={editAlbum}
              onChange={(e) => setEditAlbum(e.target.value)}
              placeholder="Album"
              className="w-full rounded border border-[#333] bg-[#111] px-2 py-1.5 text-sm text-white placeholder-neutral-600 outline-none focus:border-neutral-500"
            />
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-600">Filename (auto)</p>
              <div className="w-full truncate rounded border border-[#222] bg-[#0a0a0a] px-2 py-1.5 text-sm text-neutral-500" title={previewFilename}>
                {previewFilename || "—"}
              </div>
            </div>
            {saveError && (
              <p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-400">
                {saveError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={handleParseInModal}
                disabled={saving}
                className="flex items-center gap-1 rounded-md border border-[#333] px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:border-[#555] hover:text-white disabled:opacity-50"
                title="Split 'Artist - Title' from the filename"
              >
                <SplitSquareHorizontal size={12} />
                Parse
              </button>
              <button
                onClick={() => setManualEdit(null)}
                disabled={saving}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-[#222] hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveManual}
                disabled={saving}
                className="flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-neutral-200 disabled:opacity-50"
              >
                <Save size={12} />
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Metadata editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-lg rounded-lg border border-[#333] bg-[#0a0a0a] p-4">
            <div className="mb-2">
              <p className="truncate text-sm text-white">{editing.title || editing.filename}</p>
              <p className="truncate text-xs text-neutral-500">{editing.artist || "—"}</p>
            </div>
            <MetadataPicker
              currentTitle={editing.title}
              currentArtist={editing.artist}
              onApply={(m) =>
                applyLibraryMetadata(editing.path, m.title, m.artist, m.album, m.release_mbid)
              }
              onApplied={() => { void refresh(); }}
              onClose={() => setEditing(null)}
            />
          </div>
        </div>
      )}

      {/* Track list — scrollbar sits flush against the window edge.
          Inner padding-right keeps row content off the scrollbar. */}
      <div className="flex-1 overflow-y-auto pr-2 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-[#333] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-3">
        {displayed.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-neutral-500">
            <Music size={32} />
            <p className="text-sm">{tracks.length === 0 ? "Add a folder to get started" : "No matches"}</p>
          </div>
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-0">
            <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-black [&_th]:shadow-[inset_0_-1px_0_#222]">
              <tr className="text-left text-[10px] uppercase tracking-wider text-neutral-600">
                <th className="w-16 py-2" />
                <th className="py-2 pl-4 pr-3">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleSortClick("title")}
                      className={`flex items-center gap-1 text-[10px] uppercase tracking-wider transition-colors ${
                        sort.field === "title" ? "text-neutral-300" : "text-neutral-600 hover:text-neutral-400"
                      }`}
                    >
                      Track
                      {sort.field === "title" && (sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                    </button>
                    <button
                      onClick={() => handleSortClick("artist")}
                      className={`flex items-center gap-1 text-[10px] uppercase tracking-wider transition-colors ${
                        sort.field === "artist" ? "text-neutral-300" : "text-neutral-600 hover:text-neutral-400"
                      }`}
                    >
                      Artist
                      {sort.field === "artist" && (sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                    </button>
                    <button
                      onClick={reshuffle}
                      className={`flex items-center gap-1 text-[10px] uppercase tracking-wider transition-colors ${
                        sort.field === "random" ? "text-violet-300" : "text-neutral-600 hover:text-neutral-400"
                      }`}
                      title={sort.field === "random" ? "Reshuffle" : "Random sort"}
                    >
                      <Dices size={11} />
                      {sort.field === "random" ? "Reshuffle" : "Random"}
                    </button>
                  </div>
                </th>
                {columns.artist && <SortHeader field="artist" label="Artist" className="pr-3" />}
                {columns.album && <SortHeader field="album" label="Album" className="pr-3" />}
                {columns.duration && <SortHeader field="duration" label="Length" className="w-16 pr-3" />}
                {columns.bitrate && <SortHeader field="bitrate" label="Bitrate" className="w-20 pr-3" />}
                {columns.fileType && <SortHeader field="fileType" label="Type" className="w-16 pr-3" />}
                {columns.added && <SortHeader field="added" label="Added" className="w-24 pr-3" />}
                {columns.plays && <SortHeader field="plays" label="Plays" className="w-16 pr-3" />}
                {columns.lastPlayed && <SortHeader field="lastPlayed" label="Last Played" className="w-24 pr-3" />}
                {columns.tags && (
                  <th className="py-2 pr-3">
                    <span className="text-[10px] uppercase tracking-wider text-neutral-600">Tags</span>
                  </th>
                )}
                <th className="w-28 py-2" />
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:border-[#111]">
              {displayed.map((track) => {
                const isActive = currentTrackId === track.path;
                const isSelected = selectedPaths.has(track.path);
                return (
                  <tr
                    key={track.path}
                    onClick={(e) => handleRowClick(track.path, e)}
                    onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
                    onDragStart={(e) => e.preventDefault()}
                    className={`group cursor-default select-none text-xs hover:bg-[#111] ${
                      isSelected
                        ? "bg-violet-600/10 ring-1 ring-inset ring-violet-500/20"
                        : isActive ? "bg-[#111]" : ""
                    }`}
                  >
                    <td className="py-2 pl-6 pr-2">
                      <div className="relative h-10 w-10">
                        {track.cover_art_base64 ? (
                          <img
                            src={`data:image/jpeg;base64,${track.cover_art_base64}`}
                            alt=""
                            className="h-10 w-10 rounded object-cover transition-opacity group-hover:opacity-50"
                          />
                        ) : (
                          <div className="flex h-10 w-10 items-center justify-center rounded bg-[#1a1a1a] transition-opacity group-hover:opacity-50">
                            <Music size={14} className="text-neutral-700" />
                          </div>
                        )}
                        <button
                          onClick={() => handlePlay(track)}
                          className="absolute inset-0 flex items-center justify-center rounded text-white opacity-0 transition-opacity hover:bg-black/30 group-hover:opacity-100"
                          title="Play"
                        >
                          <Play size={16} fill="currentColor" />
                        </button>
                      </div>
                    </td>
                    <td className="py-2 pl-4 pr-3">
                      <div className="min-w-0 tracking-wide">
                        <div className={`truncate ${isActive ? "text-violet-400" : "text-white"}`}>
                          {track.title}
                        </div>
                        <div className="truncate text-[11px] text-neutral-500">
                          {track.artist || "—"}
                        </div>
                      </div>
                    </td>
                    {columns.artist && (
                      <td className="truncate py-2 pr-3 text-neutral-400">{track.artist || "—"}</td>
                    )}
                    {columns.album && (
                      <td className="truncate py-2 pr-3 text-neutral-500">{track.album || "—"}</td>
                    )}
                    {columns.duration && (
                      <td className="whitespace-nowrap py-2 pr-3 text-neutral-500">
                        {formatDuration(track.duration_secs)}
                      </td>
                    )}
                    {columns.bitrate && (
                      <td
                        className="whitespace-nowrap py-2 pr-3 text-neutral-500"
                        title={
                          track.bitrate_kbps > 0 && track.bitrate_estimated
                            ? "Estimated from file size and duration; not read from audio headers"
                            : undefined
                        }
                      >
                        {track.bitrate_kbps > 0
                          ? `${track.bitrate_kbps} kbps${track.bitrate_estimated ? " ?" : ""}`
                          : "—"}
                      </td>
                    )}
                    {columns.fileType && (
                      <td className="whitespace-nowrap py-2 pr-3">
                        {track.file_type ? (
                          <span
                            className={typeMismatch(track) ? "text-amber-400" : "text-neutral-500"}
                            title={
                              typeMismatch(track)
                                ? `Actually ${track.file_type} but named .${track.filename.split(".").pop()} — "Fix mislabeled extensions" will rename it`
                                : undefined
                            }
                          >
                            {track.file_type}
                            {typeMismatch(track) ? " ⚠" : ""}
                          </span>
                        ) : (
                          <span className="text-neutral-600">—</span>
                        )}
                      </td>
                    )}
                    {columns.added && (
                      <td
                        className="whitespace-nowrap py-2 pr-3 text-neutral-500"
                        title={absoluteDate(track.first_scanned_at)}
                      >
                        {relativeTime(track.first_scanned_at)}
                      </td>
                    )}
                    {columns.plays && (
                      <td className="whitespace-nowrap py-2 pr-3 text-neutral-500">
                        {track.play_count > 0 ? track.play_count : "—"}
                      </td>
                    )}
                    {columns.lastPlayed && (
                      <td
                        className="whitespace-nowrap py-2 pr-3 text-neutral-500"
                        title={absoluteDate(track.last_played_at)}
                      >
                        {track.last_played_at > 0 ? relativeTime(track.last_played_at) : "—"}
                      </td>
                    )}
                    {columns.tags && (
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {track.tags.slice(0, 3).map((tag) => (
                            <button
                              key={tag}
                              onClick={() => setTagFilter(tag)}
                              className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                                tagFilter === tag
                                  ? "bg-violet-600/20 text-violet-300 ring-1 ring-violet-500/40"
                                  : "bg-[#1a1a1a] text-neutral-500 hover:bg-violet-600/10 hover:text-violet-300"
                              }`}
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      </td>
                    )}
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                        <AddToPlaylistMenu trackPath={track.path} />
                        <TrackActionsMenu
                          track={track}
                          isFindingArt={findingArtFor === track.path}
                          onFindArt={() => handleFindArt(track)}
                          onAutoTag={() => setEditing(track)}
                          onEdit={() => startManualEdit(track)}
                          onDiscoverSimilar={() => handleDiscoverSimilar(track)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </div>
  );
}

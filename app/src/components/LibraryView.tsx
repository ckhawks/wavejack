import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import {
  FolderPlus,
  RefreshCw,
  Search,
  Music,
  X,
  Image as ImageIcon,
  Loader,
  Check,
  AlertTriangle,
  SplitSquareHorizontal,
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
import { ManualEditModal } from "./ManualEditModal";
import { parseArtistTitle, stripYoutubeId, YT_ID_SUFFIX } from "../lib/metadataParse";
import { PlaylistSidebar } from "./library/PlaylistSidebar";
import { TagFilterBar } from "./library/TagFilterBar";
import { SortControl } from "./library/SortControl";
import { ViewModeToggle } from "./library/ViewModeToggle";
import { LibraryTableView } from "./library/LibraryTableView";
import { LibraryCompactView } from "./library/LibraryCompactView";
import { LibraryGridView } from "./library/LibraryGridView";
import {
  DEFAULT_COLUMNS,
  DEFAULT_SORT,
  COLUMN_LABELS,
  type ColumnKey,
  type SortField,
  type SortDir,
  type SortState,
  type ViewMode,
  type LibraryListProps,
} from "./library/libraryShared";
import {
  applyLibraryMetadata,
  bulkParseLibraryTracks,
  fixLibraryExtensions,
  findCoverCandidate,
  embedCoverArt,
  type LibraryTrack,
  type CoverCandidate,
  type BulkParseEdit,
} from "../lib/commands";

/** Heuristic for "metadata needs fixing": empty artist OR title contains " - "
 * (almost always an unparsed "Artist - Title" filename). */
function needsMetadataFix(t: LibraryTrack): boolean {
  if (!t.artist?.trim()) return true;
  if (t.title && t.title.includes(" - ")) return true;
  if (t.title && YT_ID_SUFFIX.test(t.title)) return true;
  return false;
}

/** Pick the best source string to parse for a track — prefer a title that
 * already contains " - " (that's what's wrong), else fall back to the filename. */
function pickParseSource(t: LibraryTrack): string {
  if (t.title && t.title.includes(" - ")) return t.title;
  return t.filename || "";
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

  const sort = useMemo<SortState>(() => {
    try {
      return { ...DEFAULT_SORT, ...JSON.parse(settings.librarySort || "{}") };
    } catch {
      return DEFAULT_SORT;
    }
  }, [settings.librarySort]);

  const viewMode = useMemo<ViewMode>(() => {
    const v = settings.libraryViewMode;
    return v === "compact" || v === "grid" ? v : "table";
  }, [settings.libraryViewMode]);

  const setViewMode = (mode: ViewMode) => {
    void updateSetting("libraryViewMode", mode);
  };

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
        durationSecs: t.duration_secs || undefined,
      }))
    );
    playTrack({
      id: track.path,
      title: track.title,
      artist: track.artist,
      filePath: track.path,
      coverArtBase64: track.cover_art_base64 || undefined,
      durationSecs: track.duration_secs || undefined,
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

  // Shared props every layout needs to render rows and wire up interactions.
  const listProps: LibraryListProps = {
    tracks: displayed,
    currentTrackId,
    selectedPaths,
    onRowClick: handleRowClick,
    onPlay: handlePlay,
    tagFilter,
    onTagClick: setTagFilter,
    findingArtFor,
    onFindArt: handleFindArt,
    onAutoTag: (t) => setEditing(t),
    onEdit: startManualEdit,
    onDiscoverSimilar: handleDiscoverSimilar,
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
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-neutral-500 hover:text-white"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        <SortControl sort={sort} onSortClick={handleSortClick} onReshuffle={reshuffle} />
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

              {viewMode === "table" && (
                <>
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
                </>
              )}

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

      {/* Manual metadata edit modal — its own component so keystrokes don't
          re-render the whole track table. */}
      {manualEdit && (
        <ManualEditModal track={manualEdit} onClose={() => setManualEdit(null)} />
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
        ) : viewMode === "grid" ? (
          <LibraryGridView {...listProps} />
        ) : viewMode === "compact" ? (
          <LibraryCompactView {...listProps} />
        ) : (
          <LibraryTableView {...listProps} columns={columns} sort={sort} />
        )}
      </div>
      </div>
    </div>
  );
}

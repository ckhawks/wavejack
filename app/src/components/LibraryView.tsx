import { useMemo, useState } from "react";
import {
  FolderPlus,
  RefreshCw,
  Search,
  Music,
  Play,
  X,
  Wand2,
  Pencil,
  Save,
  Image as ImageIcon,
  Loader,
  Check,
  Settings as SettingsIcon,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  SplitSquareHorizontal,
  Dices,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useSettingsStore } from "../stores/settingsStore";
import { MetadataPicker } from "./MetadataPicker";
import {
  applyLibraryMetadata,
  updateLibraryTrack,
  findCoverCandidate,
  embedCoverArt,
  type LibraryTrack,
  type CoverCandidate,
} from "../lib/commands";

type SortField = "title" | "artist" | "album" | "duration" | "bitrate" | "added" | "plays" | "lastPlayed" | "random";
type SortDir = "asc" | "desc";
type ColumnKey = "artist" | "album" | "duration" | "bitrate" | "added" | "plays" | "lastPlayed";

const DEFAULT_COLUMNS: Record<ColumnKey, boolean> = {
  artist: false,
  album: true,
  duration: true,
  bitrate: false,
  added: true,
  plays: false,
  lastPlayed: false,
};
const DEFAULT_SORT: { field: SortField; dir: SortDir } = { field: "artist", dir: "asc" };

const COLUMN_LABELS: Record<ColumnKey, string> = {
  artist: "Artist (separate column)",
  album: "Album",
  duration: "Length",
  bitrate: "Bitrate",
  added: "Added",
  plays: "Play count",
  lastPlayed: "Last played",
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

export function LibraryView() {
  const { folders, tracks, scanning, searchQuery, addFolder, removeFolder, rescan, refresh, setSearchQuery, filteredTracks } = useLibraryStore();
  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.filePath);
  const settings = useSettingsStore((s) => s.settings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [showFolders, setShowFolders] = useState(folders.length === 0);
  const [showColumnMenu, setShowColumnMenu] = useState(false);
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
  const [bulkParse, setBulkParse] = useState<{ done: number; total: number } | null>(null);
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

  const filtered = filteredTracks();

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
    // A track is actionable if either:
    //   1. We can parse "Artist - Title" out of its title or filename, OR
    //   2. Its current title has a stray YT ID we can strip.
    const targets = displayed.filter((t) => {
      if (!needsMetadataFix(t)) return false;
      if (parseArtistTitle(pickParseSource(t))) return true;
      if (t.title && YT_ID_SUFFIX.test(t.title)) return true;
      return false;
    });
    if (targets.length === 0) return;
    setBulkParse({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      const track = targets[i];
      const parsed = parseArtistTitle(pickParseSource(track));
      try {
        if (parsed) {
          await updateLibraryTrack(track.path, parsed.title, parsed.artist, track.album, "");
        } else if (track.title && YT_ID_SUFFIX.test(track.title)) {
          // No parseable split — just clean the YT ID from the title.
          const cleaned = stripYoutubeId(track.title).trim();
          if (cleaned && cleaned !== track.title) {
            await updateLibraryTrack(track.path, cleaned, track.artist, track.album, "");
          }
        }
      } catch (e) {
        console.error("Bulk parse failed for", track.path, e);
      }
      setBulkParse({ done: i + 1, total: targets.length });
    }
    await refresh();
    setBulkParse(null);
  };

  const handleSaveManual = async () => {
    if (!manualEdit) return;
    setSaving(true);
    setSaveError("");
    try {
      await updateLibraryTrack(manualEdit.path, editTitle, editArtist, editAlbum, editFilename);
      await refresh();
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
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      {/* Header (padded so it doesn't kiss the window edges) */}
      <div className="flex items-center gap-2 px-6">
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
        <button
          onClick={rescan}
          disabled={scanning || folders.length === 0}
          className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300 hover:bg-[#333] disabled:opacity-40"
        >
          <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
        </button>
        <button
          onClick={handleBulkFindArt}
          disabled={!!bulkArt || tracks.length === 0}
          className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300 hover:bg-[#333] disabled:opacity-40"
          title="Find missing album art"
        >
          {bulkArt ? (
            <>
              <Loader size={14} className="animate-spin" />
              {bulkArt.done}/{bulkArt.total}
            </>
          ) : (
            <>
              <ImageIcon size={14} />
              Find Art
            </>
          )}
        </button>
        <button
          onClick={handleBulkParse}
          disabled={!!bulkParse || tracks.length === 0}
          className="flex items-center gap-1.5 rounded bg-[#222] px-3 py-2 text-xs text-neutral-300 hover:bg-[#333] disabled:opacity-40"
          title="Parse 'Artist - Title' from filename for tracks needing fix"
        >
          {bulkParse ? (
            <>
              <Loader size={14} className="animate-spin" />
              {bulkParse.done}/{bulkParse.total}
            </>
          ) : (
            <>
              <SplitSquareHorizontal size={14} />
              Parse Names
            </>
          )}
        </button>
        <button
          onClick={reshuffle}
          className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs ${
            sort.field === "random" ? "bg-violet-600/20 text-violet-300 ring-1 ring-violet-500/40" : "bg-[#222] text-neutral-300 hover:bg-[#333]"
          }`}
          title={sort.field === "random" ? "Reshuffle" : "Random sort"}
        >
          <Dices size={14} />
          {sort.field === "random" ? "Reshuffle" : "Random"}
        </button>
        <button
          onClick={() => setNeedsFixOnly((v) => !v)}
          className={`flex items-center gap-1.5 rounded px-3 py-2 text-xs ${
            needsFixOnly ? "bg-yellow-600/20 text-yellow-400 ring-1 ring-yellow-500/40" : "bg-[#222] text-neutral-300 hover:bg-[#333]"
          }`}
          title="Show only tracks with metadata problems"
        >
          <AlertTriangle size={14} />
          Needs Fix ({fixCount})
        </button>
        <div className="relative">
          <button
            onClick={() => setShowColumnMenu((v) => !v)}
            className="rounded bg-[#222] px-3 py-2 text-xs text-neutral-300 hover:bg-[#333]"
            title="Show/hide columns"
          >
            <SettingsIcon size={14} />
          </button>
          {showColumnMenu && (
            <div
              className="absolute right-0 top-full z-30 mt-1 min-w-[160px] rounded border border-[#333] bg-[#0a0a0a] p-2 shadow-xl"
              onMouseLeave={() => setShowColumnMenu(false)}
            >
              {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-neutral-300 hover:bg-[#1a1a1a]"
                >
                  <input
                    type="checkbox"
                    checked={columns[key]}
                    onChange={(e) => setColumn(key, e.target.checked)}
                  />
                  {COLUMN_LABELS[key]}
                </label>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowFolders(!showFolders)}
          className="rounded bg-[#222] px-3 py-2 text-xs text-neutral-300 hover:bg-[#333]"
        >
          Folders ({folders.length})
        </button>
      </div>

      {/* Folder management */}
      {showFolders && (
        <div className="mx-6 flex flex-col gap-1 rounded border border-[#333] bg-[#111] p-3">
          {folders.length === 0 ? (
            <p className="text-xs text-neutral-500">No folders added. Click "Add Folder" to scan your music.</p>
          ) : (
            folders.map((f) => (
              <div key={f} className="flex items-center justify-between rounded px-2 py-1 hover:bg-[#1a1a1a]">
                <span className="truncate text-xs text-neutral-300">{f}</span>
                <button onClick={() => { void removeFolder(f); }} className="ml-2 text-neutral-600 hover:text-red-400">
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Stats */}
      <div className="px-6 text-xs text-neutral-500">
        {scanning ? "Scanning..." : `${tracks.length} tracks`}
        {(searchQuery || needsFixOnly) && ` (${displayed.length} shown)`}
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
                  </div>
                </th>
                {columns.artist && <SortHeader field="artist" label="Artist" className="pr-3" />}
                {columns.album && <SortHeader field="album" label="Album" className="pr-3" />}
                {columns.duration && <SortHeader field="duration" label="Length" className="w-16 pr-3" />}
                {columns.bitrate && <SortHeader field="bitrate" label="Bitrate" className="w-20 pr-3" />}
                {columns.added && <SortHeader field="added" label="Added" className="w-24 pr-3" />}
                {columns.plays && <SortHeader field="plays" label="Plays" className="w-16 pr-3" />}
                {columns.lastPlayed && <SortHeader field="lastPlayed" label="Last Played" className="w-24 pr-3" />}
                <th className="w-24 py-2" />
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:border-[#111]">
              {displayed.map((track) => {
                const isActive = currentTrackId === track.path;
                return (
                  <tr
                    key={track.path}
                    className={`group text-xs hover:bg-[#111] ${isActive ? "bg-[#111]" : ""}`}
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
                      <td className="whitespace-nowrap py-2 pr-3 text-neutral-500">
                        {track.bitrate_kbps > 0 ? `${track.bitrate_kbps} kbps` : "—"}
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
                    <td className="py-2 pr-3">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                        {!track.cover_art_base64 && (
                          <button
                            onClick={() => handleFindArt(track)}
                            disabled={findingArtFor === track.path}
                            className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:text-white disabled:opacity-50"
                            title="Find album art"
                          >
                            {findingArtFor === track.path ? (
                              <Loader size={12} className="animate-spin" />
                            ) : (
                              <ImageIcon size={12} />
                            )}
                          </button>
                        )}
                        <button
                          onClick={() => setEditing(track)}
                          className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:text-white"
                          title="Auto-tag with MusicBrainz"
                        >
                          <Wand2 size={12} />
                        </button>
                        <button
                          onClick={() => startManualEdit(track)}
                          className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:text-white"
                          title="Edit metadata"
                        >
                          <Pencil size={12} />
                        </button>
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
  );
}

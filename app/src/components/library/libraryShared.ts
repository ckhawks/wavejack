import type { LibraryTrack } from "../../lib/commands";
import type { PlayerTrack } from "../../stores/playerStore";

/** Map a library row to the shape the player/queue consumes. The DB path is the
 * stable identity, so it doubles as both `id` and `filePath`. */
export function playerTrackFromLibrary(t: LibraryTrack): PlayerTrack {
  return {
    id: t.path,
    title: t.title,
    artist: t.artist,
    filePath: t.path,
    coverArtBase64: t.cover_art_base64 || undefined,
    durationSecs: t.duration_secs || undefined,
  };
}

export type SortField =
  | "title"
  | "artist"
  | "album"
  | "duration"
  | "bitrate"
  | "fileType"
  | "added"
  | "plays"
  | "lastPlayed"
  | "random";
export type SortDir = "asc" | "desc";
export type ColumnKey =
  | "artist"
  | "album"
  | "duration"
  | "bitrate"
  | "fileType"
  | "added"
  | "plays"
  | "lastPlayed"
  | "tags";

/** The three library layouts. "table" is the default dense list. */
export type ViewMode = "table" | "compact" | "grid";

export interface SortState {
  field: SortField;
  dir: SortDir;
  /** Present only when field === "random"; seeds the stable shuffle. */
  seed?: number;
}

export const DEFAULT_COLUMNS: Record<ColumnKey, boolean> = {
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

export const DEFAULT_SORT: SortState = { field: "artist", dir: "asc" };

export const COLUMN_LABELS: Record<ColumnKey, string> = {
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

/** Sort fields offered by the shared sort dropdown (random is a separate
 * reshuffle button, so it's excluded here). */
export const SORT_FIELDS: Array<{ field: SortField; label: string }> = [
  { field: "title", label: "Title" },
  { field: "artist", label: "Artist" },
  { field: "album", label: "Album" },
  { field: "duration", label: "Length" },
  { field: "bitrate", label: "Bitrate" },
  { field: "fileType", label: "Type" },
  { field: "added", label: "Date added" },
  { field: "plays", label: "Play count" },
  { field: "lastPlayed", label: "Last played" },
];

export function relativeTime(unixSecs: number): string {
  if (!unixSecs) return "—";
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

export function absoluteDate(unixSecs: number): string {
  if (!unixSecs) return "";
  return new Date(unixSecs * 1000).toLocaleString();
}

export function formatDuration(secs: number): string {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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
export function typeMismatch(t: LibraryTrack): boolean {
  if (!t.file_type) return false;
  const ext = t.filename.split(".").pop()?.toLowerCase();
  const accepted = TYPE_EXTENSIONS[t.file_type];
  if (!ext || !accepted) return false;
  return !accepted.includes(ext);
}

/** Everything the three layout components need to render rows and wire up
 * play / select / per-track actions. Shared so table, compact, and grid views
 * stay behaviorally identical. */
export interface LibraryListProps {
  tracks: LibraryTrack[];
  currentTrackId: string | undefined;
  selectedPaths: Set<string>;
  onRowClick: (path: string, e: React.MouseEvent) => void;
  onPlay: (track: LibraryTrack) => void;
  tagFilter: string | null;
  onTagClick: (tag: string | null) => void;
  findingArtFor: string | null;
  onFindArt: (track: LibraryTrack) => void;
  onAutoTag: (track: LibraryTrack) => void;
  onEdit: (track: LibraryTrack) => void;
  onDiscoverSimilar: (track: LibraryTrack) => void;
}

/** Represents a single download in the queue */
export interface DownloadItem {
  id: string;
  url: string;
  format: "mp4" | "mp3";
  status: "pending" | "downloading" | "converting" | "complete" | "error" | "file_missing";
  progress: number;
  message: string;
  backend: "ytdlp" | "cobalt" | "ffmpeg" | "none" | "";
  title?: string;
  artist?: string;
  album?: string;
  coverArtBase64?: string;
  filePath?: string;
  playlistTitle?: string;
}

/** App settings persisted via Tauri plugin-store */
export interface AppSettings {
  outputDir: string;
  musicDir: string;
  cobaltUrl: string;
  format: "mp4" | "mp3";
  lastfmApiKey: string;
  lastDestination: "downloads" | "music";
  /** JSON-encoded record of which library columns are visible. */
  libraryColumns: string;
  /** JSON-encoded { field, dir } sort state for the library table. */
  librarySort: string;
  /** Last active tab so we can restore on relaunch. */
  lastTab: string;
}

/** Shape of the download-status event from Rust */
export interface DownloadStatusEvent {
  id: string;
  status: string;
  progress: number;
  message: string;
  backend: string;
  title?: string;
  file_path?: string;
  cover_art_base64?: string;
}

/** A download record from the SQLite database */
export interface DownloadRecord {
  id: string;
  url: string;
  format: string;
  status: string;
  title: string;
  artist: string;
  album: string;
  cover_art_path: string;
  file_path: string;
  backend: string;
  message: string;
  playlist_title: string;
  created_at: string;
  cover_art_base64: string;
}

/** Shape of the ytdlp-download-progress event from Rust */
export interface YtdlpProgressEvent {
  stage: "downloading" | "complete";
  progress: number;
}

/** A metadata match from MusicBrainz */
export interface MetadataMatch {
  title: string;
  artist: string;
  album: string;
  release_mbid: string;
  score: number;
}

/** Result of applying metadata to a file */
export interface AppliedMetadata {
  title: string;
  artist: string;
  album: string;
  cover_art_base64: string | null;
  new_file_path: string;
}

/** A single entry in a playlist */
export interface PlaylistEntry {
  url: string;
  title: string;
  duration: number | null;
  uploader: string | null;
}

/** A seed track for the Discover feature */
export interface SeedTrack {
  title: string;
  artist: string;
}

/** A similar track returned by Last.fm or SoundCloud */
export interface SimilarTrack {
  name: string;
  artist: string;
  match_score: number;
  source: "lastfm" | "soundcloud" | "youtube";
}

/** A track in the Discover queue */
export interface DiscoverItem {
  id: string;
  title: string;
  artist: string;
  matchScore: number;
  source: "lastfm" | "soundcloud" | "youtube";
  status: "pending" | "downloading" | "ready" | "error";
  progress: number;
  message: string;
  filePath?: string;
  coverArtBase64?: string;
}

/** A search result from YouTube or SoundCloud */
export interface SearchResult {
  id: string;
  title: string;
  artist: string;
  duration_secs: number;
  thumbnail_url: string;
  source: "youtube" | "soundcloud";
  url: string;
}

/** Playlist info extracted via yt-dlp */
export interface PlaylistInfo {
  title: string;
  uploader: string | null;
  entries: PlaylistEntry[];
  playlist_url: string;
}

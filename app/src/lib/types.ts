/** Represents a single download in the queue */
export interface DownloadItem {
  id: string;
  url: string;
  format: "mp4" | "mp3" | "flac";
  status: "pending" | "downloading" | "converting" | "complete" | "error" | "file_missing";
  progress: number;
  message: string;
  backend: "ytdlp" | "cobalt" | "ffmpeg" | "tidal-dl-ng" | "none" | "";
  title?: string;
  artist?: string;
  album?: string;
  coverArtBase64?: string;
  filePath?: string;
  playlistTitle?: string;
  /** Actual file extension (e.g. "flac", "m4a") — set by the post-download
   *  enrichment event. Overrides the pre-set intent in `format` for display. */
  audioFormat?: string;
  /** Real bitrate read from the file's frame headers, kbps. 0 = unknown. */
  bitrateKbps?: number;
}

export interface DownloadEnrichedEvent {
  id: string;
  audio_format: string;
  bitrate_kbps: number;
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
  /** Spotify Web API client credentials (user-provided via Spotify Dev Dashboard). */
  spotifyClientId: string;
  spotifyClientSecret: string;
  /** Browser to extract SoundCloud cookies from (chrome|firefox|edge|brave|safari...).
   *  Empty = no cookies → yt-dlp falls back to the 128/160 kbps SoundCloud stream
   *  instead of the uploader's original file. Any free SC account is enough. */
  soundcloudCookiesBrowser: string;
  /** Comma-separated list of enabled search sources ("youtube,soundcloud"). */
  searchSourcesEnabled: string;
}

/** A single Spotify track as returned by the Web API (fields we care about). */
export interface SpotifyTrack {
  id: string;
  name: string;
  artists: string[];
  album: string;
  isrc: string | null;
  duration_ms: number;
}

/** Metadata for a fetched Spotify playlist. */
export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: string;
  playlist_url: string;
  tracks: SpotifyTrack[];
}

/** Authenticated Spotify user — returned by login / auth-status. */
export interface SpotifyUser {
  id: string;
  display_name: string;
}

/** Pending Tidal device-code flow — the UI shows verification_url + user_code
 *  while we poll for approval. */
export interface TidalDeviceAuth {
  verification_url: string;
  user_code: string;
  device_code: string;
  expires_in: number;
  interval: number;
}

export interface TidalUser {
  id: number;
  country_code: string;
}

/** Minimal Spotify track payload the Tidal matcher consumes. */
export interface TidalMatchInput {
  spotify_id: string;
  name: string;
  artists: string[];
  isrc: string | null;
  duration_ms: number;
}

export type TidalMatchStatus = "found_isrc" | "found_fuzzy" | "not_found" | "error";

export interface TidalMatch {
  spotify_id: string;
  status: TidalMatchStatus;
  tidal_id: number | null;
  tidal_title: string | null;
  tidal_artists: string[] | null;
  tidal_quality: string | null;
  tidal_url: string | null;
  reason: string | null;
}

/** Payload of the "tidal-match-progress" Tauri event. */
export interface TidalMatchProgress {
  index: number;
  total: number;
  match: TidalMatch;
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

/** A playlist stored in the database */
export interface Playlist {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  track_count: number;
}

/** A tag with its usage count */
export interface TagInfo {
  id: number;
  name: string;
  track_count: number;
}

/** A search result from any enabled source (YT / SC / Tidal / Spotify). */
export interface SearchResult {
  id: string;
  title: string;
  artist: string;
  duration_secs: number;
  thumbnail_url: string;
  source: "youtube" | "soundcloud" | "tidal" | "spotify";
  url: string;
}

/** A YouTube channel subscription */
export interface Subscription {
  id: string;
  name: string;
  url: string;
  thumbnail: string;
  added_at: number;
}

/** A video from a subscribed channel's feed */
export interface FeedItem {
  video_id: string;
  channel_id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  upload_date: string;
  url: string;
}

/** Playlist info extracted via yt-dlp */
export interface PlaylistInfo {
  title: string;
  uploader: string | null;
  entries: PlaylistEntry[];
  playlist_url: string;
}

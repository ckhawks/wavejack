import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  AppliedMetadata,
  DownloadRecord,
  MetadataMatch,
  PlaylistInfo,
  SearchResult,
} from "./types";

/** Start downloading a URL with the given format */
export async function startDownload(
  id: string,
  url: string,
  format: string,
  playlistTitle?: string,
  destination: "downloads" | "music" = "downloads",
): Promise<void> {
  return invoke("start_download", { id, url, format, playlistTitle, destination });
}

/** Ensure yt-dlp is ready (downloads if needed). Returns the binary path. */
export async function ensureYtdlpReady(): Promise<string> {
  return invoke("ensure_ytdlp_ready");
}

/** Get current app settings */
export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

/** Update a single setting */
export async function setSetting(
  key: string,
  value: string
): Promise<void> {
  return invoke("set_setting", { key, value });
}

/** Open a file with the system default application */
export async function openFile(path: string): Promise<void> {
  return invoke("open_file", { path });
}

/** Reveal a file in the system file explorer */
export async function revealFile(path: string): Promise<void> {
  return invoke("reveal_file", { path });
}

/** Update MP3 metadata (ID3 tags) and optionally rename the file. Returns new path. */
export async function updateMp3Metadata(
  id: string,
  path: string,
  title: string,
  artist: string,
  newFilename: string
): Promise<string> {
  return invoke("update_mp3_metadata", { id, path, title, artist, newFilename });
}

/** Get all download history records from the database */
export async function getDownloadHistory(): Promise<DownloadRecord[]> {
  return invoke("get_download_history");
}

/** Remove a single download history record */
export async function removeDownloadHistory(id: string): Promise<void> {
  return invoke("remove_download_history", { id });
}

/** Clear all download history */
export async function clearDownloadHistory(): Promise<void> {
  return invoke("clear_download_history");
}

/** Search MusicBrainz for metadata matches */
export async function fetchMetadata(query: string): Promise<MetadataMatch[]> {
  return invoke("fetch_metadata", { query });
}

/** Apply metadata from MusicBrainz to a downloaded MP3 */
export async function applyMetadata(
  id: string,
  path: string,
  title: string,
  artist: string,
  album: string,
  releaseMbid: string
): Promise<AppliedMetadata> {
  return invoke("apply_metadata", { id, path, title, artist, album, releaseMbid });
}

/** Extract audio from a video file (e.g. MP4) and save as MP3. Returns the output path. */
export async function extractAudio(id: string, inputPath: string): Promise<string> {
  return invoke("extract_audio", { id, inputPath });
}

/** Search YouTube and SoundCloud for tracks matching a query */
export async function searchSources(query: string): Promise<SearchResult[]> {
  return invoke("search_sources", { query });
}

/** Download a search result to the preview directory for inline playback */
export async function searchPreview(id: string, url: string, title: string): Promise<void> {
  return invoke("search_preview", { id, url, title });
}

/** Fetch similar tracks from Last.fm, SoundCloud, and YouTube */
export async function discoverSimilar(
  seeds: import("./types").SeedTrack[],
  lastfmApiKey: string
): Promise<import("./types").SimilarTrack[]> {
  return invoke("discover_similar", { seeds, lastfmApiKey });
}

/** Download a preview of a discovered track via yt-dlp search */
export async function discoverPreview(
  id: string,
  title: string,
  artist: string
): Promise<void> {
  return invoke("discover_preview", { id, title, artist });
}

/** Move a preview file to the output directory (keep it) */
export async function discoverKeep(
  id: string,
  sourcePath: string
): Promise<string> {
  return invoke("discover_keep", { id, sourcePath });
}

/** Delete a single preview file */
export async function discoverTrash(filePath: string): Promise<void> {
  return invoke("discover_trash", { filePath });
}

/** Delete all preview files */
export async function discoverCleanup(): Promise<void> {
  return invoke("discover_cleanup");
}

/** Extract playlist entries from a URL */
export async function extractPlaylist(url: string): Promise<PlaylistInfo> {
  return invoke("extract_playlist", { url });
}

/** Scan a directory for audio files and return metadata */
export interface LibraryTrack {
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  duration_secs: number;
  cover_art_base64: string;
  /** Unix seconds when this row was first added to the library cache. */
  first_scanned_at: number;
  /** Approximate average bitrate in kbps; 0 when unknown. */
  bitrate_kbps: number;
  /** Number of natural finishes (Last.fm-style — skips don't count). */
  play_count: number;
  /** Unix seconds of the most recent natural finish, 0 if never. */
  last_played_at: number;
}

export async function recordTrackPlay(path: string): Promise<void> {
  return invoke("record_track_play", { path });
}

export interface LibraryScanResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export async function getLibraryFolders(): Promise<string[]> {
  return invoke("get_library_folders");
}

export async function addLibraryFolder(path: string): Promise<void> {
  return invoke("add_library_folder", { path });
}

export async function removeLibraryFolder(path: string): Promise<void> {
  return invoke("remove_library_folder", { path });
}

export async function getLibraryTracks(): Promise<LibraryTrack[]> {
  return invoke("get_library_tracks");
}

export async function scanLibraryIncremental(path: string): Promise<LibraryScanResult> {
  return invoke("scan_library_incremental", { path });
}

export async function applyLibraryMetadata(
  path: string,
  title: string,
  artist: string,
  album: string,
  releaseMbid: string,
): Promise<AppliedMetadata> {
  return invoke("apply_library_metadata", { path, title, artist, album, releaseMbid });
}

export interface CoverCandidate {
  source: "music_brainz" | "download_history" | "youtube_search";
  image_base64: string;
  source_url?: string;
}

export async function findCoverCandidate(
  path: string,
  title: string,
  artist: string,
  allowYoutubeSearch: boolean,
): Promise<CoverCandidate | null> {
  return invoke("find_cover_candidate", { path, title, artist, allowYoutubeSearch });
}

export async function embedCoverArt(path: string, imageBase64: string): Promise<void> {
  return invoke("embed_cover_art", { path, imageBase64 });
}

/** Get a cached SoundCloud-style amplitude profile (500 bytes, 0..=255) for
 * the file. Computes + caches on first call. */
export async function getOrComputeWaveform(path: string): Promise<number[]> {
  return invoke("get_or_compute_waveform", { path });
}

export async function updateLibraryTrack(
  path: string,
  title: string,
  artist: string,
  album: string,
  newFilename: string,
): Promise<string> {
  return invoke("update_library_track", { path, title, artist, album, newFilename });
}

/** Read cover art from a single audio file */
export async function getTrackCoverArt(path: string): Promise<string> {
  return invoke("get_track_cover_art", { path });
}

/** Get remote-control info (token + port) for external controllers */
export interface RemoteInfo {
  token: string;
  port: number;
}

export async function getRemoteInfo(): Promise<RemoteInfo> {
  return invoke("get_remote_info");
}

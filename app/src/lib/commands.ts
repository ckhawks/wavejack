import { invoke } from "@tauri-apps/api/core";

/** Tauri commands reject with a serialized AppError — `{kind, message}` — not
 *  a real `Error`, so `String(e)` / `e.message` both give "[object Object]".
 *  Use this to surface the actual message in the UI. */
export function formatErr(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; kind?: unknown };
    if (typeof o.message === "string" && o.message) return o.message;
    try { return JSON.stringify(e); } catch { /* fall through */ }
  }
  return String(e);
}
import type {
  AppSettings,
  AppliedMetadata,
  DownloadRecord,
  FeedItem,
  MetadataMatch,
  Playlist,
  PlaylistInfo,
  PlaylistEntry,
  SearchResult,
  SpotifyPlaylist,
  SpotifyUser,
  Subscription,
  TidalDeviceAuth,
  TidalMatch,
  TidalMatchInput,
  TidalUser,
  ScMatchInput,
  ScTidalMatch,
  CookieCheck,
} from "./types";

/** Start downloading a URL with the given format */
export async function startDownload(
  id: string,
  url: string,
  format: string,
  playlistTitle?: string,
  destination: "downloads" | "music" | "song-requests" = "downloads",
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

/** Search enabled sources for tracks matching a query.
 *  `sources` = array of "youtube" / "soundcloud". Omit to search all. */
export async function searchSources(
  query: string,
  sources?: string[],
): Promise<SearchResult[]> {
  return invoke("search_sources", { query, sources });
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

/** Check whether the given browser yields a logged-in SoundCloud session. */
export async function validateSoundcloudCookies(browser: string): Promise<CookieCheck> {
  return invoke("validate_soundcloud_cookies", { browser });
}

/** Resolve a single SoundCloud track URL to its metadata + DRM status. */
export async function resolveSoundcloudTrack(url: string): Promise<PlaylistEntry> {
  return invoke("resolve_soundcloud_track", { url });
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
  /** True when bitrate_kbps was derived from size/duration rather than read
   *  from audio frame headers — the UI should mark it as uncertain. */
  bitrate_estimated: boolean;
  /** Number of natural finishes (Last.fm-style — skips don't count). */
  play_count: number;
  /** Unix seconds of the most recent natural finish, 0 if never. */
  last_played_at: number;
  /** Top tags from Last.fm (populated from track_tags table). */
  tags: string[];
  /** Content-detected container type ("MP3", "M4A", "FLAC", ...). May differ
   *  from the filename extension for mislabeled files. Empty until scanned. */
  file_type: string;
}

export async function recordTrackPlay(path: string): Promise<void> {
  return invoke("record_track_play", { path });
}

/** Log that a library track started playing (skips included), for the Recent view. */
export async function recordPlayStart(path: string): Promise<void> {
  return invoke("record_play_start", { path });
}

/** A single playback-start event joined to its library track. */
export interface PlayHistoryEntry {
  /** play_history row id — a stable, unique key (a track can repeat in the list). */
  id: number;
  /** Unix seconds when playback started. */
  played_at: number;
  track: LibraryTrack;
}

/** Most recent plays, newest first, repeats included. */
export async function getRecentlyPlayed(limit?: number): Promise<PlayHistoryEntry[]> {
  return invoke("get_recently_played", { limit });
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

/** One parsed track edit for bulkParseLibraryTracks. */
export interface BulkParseEdit {
  path: string;
  title: string;
  artist: string;
  album: string;
}

/** Apply many parsed "Artist - Title" edits at once. The backend rewrites tags
 * and renames files concurrently and emits `library-bulk-parse-progress`
 * ({ done, total, current }) events. Returns the count of tracks updated. */
export async function bulkParseLibraryTracks(edits: BulkParseEdit[]): Promise<number> {
  return invoke("bulk_parse_library_tracks", { edits });
}

/** Scan every library track, rename files whose extension doesn't match their
 * real container (e.g. AAC/MP4 saved as ".mp3"), and refresh cached types.
 * Emits `library-fix-ext-progress` ({ done, total, current, fixed }) events.
 * Returns the number of files renamed. */
export async function fixLibraryExtensions(): Promise<number> {
  return invoke("fix_library_extensions", {});
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

// ======================== Native audio playback ========================
// Audio decode + output runs in the Rust process so that screenshare/window
// capture sees it (WebView2's audio child process was opaque to per-window
// capture). The frontend is now a controller; samples never enter the webview.

export interface AudioLoadResult {
  duration: number;
}

export async function audioLoad(path: string): Promise<AudioLoadResult> {
  return invoke("audio_load", { path });
}

export async function audioPlay(): Promise<void> {
  return invoke("audio_play");
}

export async function audioPause(): Promise<void> {
  return invoke("audio_pause");
}

export async function audioStop(): Promise<void> {
  return invoke("audio_stop");
}

export async function audioSeek(secs: number): Promise<void> {
  return invoke("audio_seek", { secs });
}

export async function audioSetVolume(volume: number): Promise<void> {
  return invoke("audio_set_volume", { volume });
}

// ======================== Playlists ========================

export async function createPlaylist(name: string): Promise<Playlist> {
  return invoke("create_playlist", { name });
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  return invoke("rename_playlist", { id, name });
}

export async function deletePlaylist(id: string): Promise<void> {
  return invoke("delete_playlist", { id });
}

export async function listPlaylists(): Promise<Playlist[]> {
  return invoke("list_playlists");
}

export async function getPlaylistTracks(playlistId: string): Promise<LibraryTrack[]> {
  return invoke("get_playlist_tracks", { playlistId });
}

export async function addToPlaylist(playlistId: string, paths: string[]): Promise<void> {
  return invoke("add_to_playlist", { playlistId, paths });
}

export async function removeFromPlaylist(playlistId: string, trackPath: string): Promise<void> {
  return invoke("remove_from_playlist", { playlistId, trackPath });
}

export async function reorderPlaylist(playlistId: string, paths: string[]): Promise<void> {
  return invoke("reorder_playlist", { playlistId, paths });
}

// ======================== Tags ========================

export async function fetchTrackTags(path: string, title: string, artist: string): Promise<Array<[string, number]>> {
  return invoke("fetch_track_tags", { path, title, artist });
}

export async function bulkFetchTags(): Promise<void> {
  return invoke("bulk_fetch_tags");
}

export async function getAllTags(): Promise<Array<[number, string, number]>> {
  return invoke("get_all_tags");
}

export async function getTracksForTag(tagName: string): Promise<string[]> {
  return invoke("get_tracks_for_tag", { tagName });
}

// ======================== Feed / Subscriptions ========================

export async function addSubscription(url: string): Promise<Subscription> {
  return invoke("add_subscription", { url });
}

export async function removeSubscription(id: string): Promise<void> {
  return invoke("remove_subscription", { id });
}

export async function listSubscriptions(): Promise<Subscription[]> {
  return invoke("list_subscriptions");
}

export async function refreshFeed(): Promise<void> {
  return invoke("refresh_feed");
}

export async function getFeed(): Promise<FeedItem[]> {
  return invoke("get_feed");
}

// ======================== Spotify ========================

/** Run the full PKCE login flow if needed, or return the cached user. Opens a browser. */
export async function spotifyLogin(): Promise<SpotifyUser> {
  return invoke("spotify_login");
}

/** Check cached auth state without launching the browser. Returns null if not authed. */
export async function spotifyAuthStatus(): Promise<SpotifyUser | null> {
  return invoke("spotify_auth_status");
}

/** Clear the cached Spotify token. */
export async function spotifyLogout(): Promise<void> {
  return invoke("spotify_logout");
}

/** Fetch a Spotify playlist's tracks (triggers login if not yet authed). */
export async function spotifyFetchPlaylist(url: string): Promise<SpotifyPlaylist> {
  return invoke("spotify_fetch_playlist", { url });
}

/** Fetch a single Spotify track as a 1-track synthetic playlist — lets the
 *  preview UI handle singletons identically to real playlists. */
export async function spotifyFetchTrack(url: string): Promise<SpotifyPlaylist> {
  return invoke("spotify_fetch_track", { url });
}

/** Fetch a Spotify album's tracks (with ISRCs) as a playlist — routes through
 *  the same Web API → Tidal pipeline as playlists. */
export async function spotifyFetchAlbum(url: string): Promise<SpotifyPlaylist> {
  return invoke("spotify_fetch_album", { url });
}

/** Cheap server-side check — used by UrlInput to branch before fetching. */
export async function isSpotifyPlaylistUrl(url: string): Promise<boolean> {
  return invoke("is_spotify_playlist_url", { url });
}

// ======================== Tidal ========================

/** Start the device-code OAuth flow. Opens a browser to the approval URL and
 *  returns the URL/code so the UI can display them. */
export async function tidalLoginStart(): Promise<TidalDeviceAuth> {
  return invoke("tidal_login_start");
}

/** Poll Tidal until the user approves (or 5-min timeout). Must follow
 *  tidalLoginStart in the same app session. */
export async function tidalLoginFinish(): Promise<TidalUser> {
  return invoke("tidal_login_finish");
}

export async function tidalAuthStatus(): Promise<TidalUser | null> {
  return invoke("tidal_auth_status");
}

export async function tidalLogout(): Promise<void> {
  return invoke("tidal_logout");
}

/** Resolve a batch of Spotify tracks to Tidal matches (ISRC first, fuzzy
 *  fallback). Emits "tidal-match-progress" per track. */
export async function tidalMatchTracks(tracks: TidalMatchInput[]): Promise<TidalMatch[]> {
  return invoke("tidal_match_tracks", { tracks });
}

/** Cancel an in-flight tidalMatchTracks run so the backend stops hitting Tidal.
 *  Called when the Spotify preview modal closes mid-match. */
export async function tidalCancelMatch(): Promise<void> {
  return invoke("tidal_cancel_match");
}

/** Fuzzy-match a SoundCloud playlist's entries against Tidal so the user can
 *  upgrade individual tracks to lossless. Emits "tidal-sc-match-progress" per
 *  entry. No ISRC path — SoundCloud exposes none. */
export async function tidalMatchSoundcloud(entries: ScMatchInput[]): Promise<ScTidalMatch[]> {
  return invoke("tidal_match_soundcloud", { entries });
}

export interface TidalDownloadJob {
  id: string;
  tidal_url: string;
  title?: string;
}

/** Kick off a batch Tidal download via tidal-dl-ng. Returns immediately;
 *  progress streams over "download-status" events. */
export async function tidalDownloadMatched(
  jobs: TidalDownloadJob[],
  destination: "downloads" | "music" | "song-requests",
  playlistTitle?: string,
): Promise<void> {
  return invoke("tidal_download_matched", { jobs, destination, playlistTitle });
}

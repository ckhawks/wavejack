import { useState, useCallback, useEffect, useRef } from "react";
import { Download, Loader, Music, Video, FileAudio, FolderDown, Library, Search, Youtube, Cloud, Waves, Disc } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePlayerStore } from "../stores/playerStore";
import {
  startDownload, extractPlaylist, extractAudio, searchSources, searchPreview,
  discoverKeep, discoverTrash, spotifyFetchPlaylist, spotifyFetchTrack, formatErr,
  tidalDownloadMatched, tidalAuthStatus, spotifyAuthStatus,
} from "../lib/commands";
import { PlaylistPreview } from "./PlaylistPreview";
import { SpotifyPlaylistPreview } from "./SpotifyPlaylistPreview";
import { SearchResults, type PreviewState } from "./SearchResults";
import type { PlaylistInfo, SearchResult, DownloadStatusEvent, SpotifyPlaylist } from "../lib/types";

function isUrl(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function isPlaylistUrl(url: string): boolean {
  return (
    url.includes("list=") ||
    url.includes("/playlist") ||
    url.includes("/sets/") ||
    /spotify\.com\/(playlist|album)\//.test(url)
  );
}

function isSpotifyPlaylistUrlClient(url: string): boolean {
  return /(^https?:\/\/open\.spotify\.com\/playlist\/|^spotify:playlist:)/.test(url);
}

function isSpotifyTrackUrlClient(url: string): boolean {
  return /(^https?:\/\/open\.spotify\.com\/track\/|^spotify:track:)/.test(url);
}

export function UrlInput() {
  const [url, setUrl] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null);
  const [spotifyPlaylist, setSpotifyPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [spotifyError, setSpotifyError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [previews, setPreviews] = useState<Map<string, PreviewState>>(new Map());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const format = useSettingsStore((s) => s.settings.format);
  const destination = useSettingsStore((s) => s.settings.lastDestination);
  const searchSourcesEnabled = useSettingsStore((s) => s.settings.searchSourcesEnabled);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const addDownload = useDownloadStore((s) => s.addDownload);

  const setFormat = (f: "mp4" | "mp3") => updateSetting("format", f);
  const setDestination = (d: "downloads" | "music" | "song-requests") =>
    updateSetting("lastDestination", d);

  const enabledSources: string[] = searchSourcesEnabled
    ? searchSourcesEnabled.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const toggleSource = (source: "youtube" | "soundcloud" | "tidal" | "spotify") => {
    const has = enabledSources.includes(source);
    const next = has
      ? enabledSources.filter((s) => s !== source)
      : [...enabledSources, source];
    updateSetting("searchSourcesEnabled", next.join(","));
  };

  // Track which external services are logged in so we only show their
  // pills when the user could actually get results. Tidal tokens are
  // revoked by their side on a short schedule, so we also listen for
  // `tidal-auth-expired` and refresh reactively after login events.
  const [tidalAuthed, setTidalAuthed] = useState(false);
  const [spotifyAuthed, setSpotifyAuthed] = useState(false);
  const [tidalAuthExpired, setTidalAuthExpired] = useState(false);
  useEffect(() => {
    const refresh = () => {
      tidalAuthStatus().then((u) => setTidalAuthed(u !== null)).catch(() => setTidalAuthed(false));
      spotifyAuthStatus().then((u) => setSpotifyAuthed(u !== null)).catch(() => setSpotifyAuthed(false));
    };
    refresh();

    const unExpired = listen("tidal-auth-expired", () => {
      setTidalAuthed(false);
      setTidalAuthExpired(true);
    });
    const unChanged = listen<boolean>("tidal-auth-changed", (e) => {
      setTidalAuthed(e.payload === true);
      if (e.payload === true) setTidalAuthExpired(false);
    });
    const unSpotifyChanged = listen<boolean>("spotify-auth-changed", (e) => {
      setSpotifyAuthed(e.payload === true);
    });
    return () => {
      unExpired.then((fn) => fn()).catch(() => {});
      unChanged.then((fn) => fn()).catch(() => {});
      unSpotifyChanged.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const handleSubmit = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    if (isUrl(trimmed)) {
      // Clear any search results when switching to URL mode
      setSearchResults([]);
      setHasSearched(false);
      setSpotifyError(null);

      // Spotify playlists and single tracks both route through the Web API
      // → Tidal pipeline, not yt-dlp. The backend returns a 1-track synthetic
      // playlist for track URLs so the preview UI is uniform.
      if (isSpotifyPlaylistUrlClient(trimmed) || isSpotifyTrackUrlClient(trimmed)) {
        const isTrack = isSpotifyTrackUrlClient(trimmed);
        setExtracting(true);
        try {
          const pl = isTrack
            ? await spotifyFetchTrack(trimmed)
            : await spotifyFetchPlaylist(trimmed);
          setSpotifyPlaylist(pl);
          setUrl("");
        } catch (e) {
          setSpotifyError(formatErr(e));
        } finally {
          setExtracting(false);
        }
        return;
      }

      // Check if it's a playlist URL
      if (isPlaylistUrl(trimmed)) {
        setExtracting(true);
        try {
          const info = await extractPlaylist(trimmed);
          setPlaylist(info);
          setUrl("");
        } catch {
          // Not a playlist or extraction failed — fall through to normal download
          doSingleDownload(trimmed);
        } finally {
          setExtracting(false);
        }
        return;
      }

      doSingleDownload(trimmed);
    } else {
      // Search query
      handleSearch(trimmed);
    }
  };

  const handleSearch = async (query: string) => {
    setSearching(true);
    setHasSearched(true);
    try {
      const results = await searchSources(query, enabledSources);
      setSearchResults(results);
    } catch (e) {
      console.error("Search failed:", e);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const doSingleDownload = (trimmedUrl: string) => {
    const id = crypto.randomUUID();
    addDownload({
      id,
      url: trimmedUrl,
      format,
      status: "pending",
      progress: 0,
      message: "Starting...",
      backend: "",
    });
    setUrl("");
    startDownload(id, trimmedUrl, format, undefined, destination).catch((e) =>
      console.error("Failed to start download:", e)
    );
  };

  // Preview download progress can arrive on either event channel:
  // - "search-preview-status" is what the dedicated preview path emits.
  // - "download-status" is the generic yt-dlp channel; we accept it too so
  //   results that fall through to the regular downloader still surface.
  // Both run the same handler — a previously-duplicated block now collapsed.
  useEffect(() => {
    const handle = (
      payload: DownloadStatusEvent,
      requireKnownPreview: boolean,
    ) => {
      const { id, status, progress, message, file_path, cover_art_base64 } = payload;
      if (requireKnownPreview && !previewsRef.current.has(id)) return;
      setPreviews((prev) => {
        const next = new Map(prev);
        const existing = next.get(id) ?? { status: "pending", progress: 0, message: "" };
        if (status === "complete") {
          next.set(id, {
            ...existing,
            status: "ready",
            progress: 100,
            message: "Ready",
            filePath: file_path ?? undefined,
            coverArtBase64: cover_art_base64 ?? undefined,
          });
          const result = searchResultsRef.current.find((r) => r.id === id);
          if (result && file_path) {
            usePlayerStore.getState().playTrack({
              id: result.id,
              title: result.title,
              artist: result.artist,
              filePath: file_path,
              coverArtBase64: cover_art_base64 ?? undefined,
            });
          }
        } else if (status === "error") {
          next.set(id, { ...existing, status: "error", progress: 0, message });
        } else {
          next.set(id, { ...existing, status: "downloading", progress, message });
        }
        return next;
      });
    };

    const unlistenPreview = listen<DownloadStatusEvent>(
      "search-preview-status",
      (e) => handle(e.payload, false),
    );
    const unlistenDownload = listen<DownloadStatusEvent>(
      "download-status",
      (e) => handle(e.payload, true),
    );

    return () => {
      unlistenPreview.then((fn) => fn()).catch(() => {});
      unlistenDownload.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const searchResultsRef = useRef(searchResults);
  searchResultsRef.current = searchResults;

  // Play/preview a search result — downloads to temp dir, auto-plays when ready
  const handlePreview = useCallback((result: SearchResult) => {
    const existing = previewsRef.current.get(result.id);
    if (existing?.status === "ready" && existing.filePath) {
      // Already downloaded — just play it
      usePlayerStore.getState().playTrack({
        id: result.id,
        title: result.title,
        artist: result.artist,
        filePath: existing.filePath,
        coverArtBase64: existing.coverArtBase64,
      });
      return;
    }
    if (existing?.status === "downloading") return; // Already in progress

    setPreviews((prev) => {
      const next = new Map(prev);
      next.set(result.id, { status: "downloading", progress: 0, message: "Starting preview..." });
      return next;
    });
    searchPreview(result.id, result.url, result.title).catch((e) =>
      console.error("Failed to start preview:", e)
    );
  }, []);

  // Save a previewed track to the output directory.
  //
  // Tidal previews are intentionally low-res (HIGH tier ~96k AAC) for speed,
  // so saving must re-download at full quality — we don't want the 96k file
  // ending up in the library. YouTube/SoundCloud previews are already best-
  // audio, so we just move the preview file.
  const handleSave = useCallback(async (result: SearchResult) => {
    if (result.source === "tidal") {
      const id = crypto.randomUUID();
      addDownload({
        id,
        url: result.url,
        format: "flac",
        status: "pending",
        progress: 0,
        message: "Starting full-res Tidal download...",
        backend: "tidal-dl-ng",
        title: result.title,
      });
      setSavedIds((prev) => new Set(prev).add(result.id));
      tidalDownloadMatched(
        [{ id, tidal_url: result.url, title: `${result.artist} - ${result.title}` }],
        destination,
      ).catch((e) => console.error("Failed to save Tidal track:", e));
      return;
    }

    const preview = previewsRef.current.get(result.id);
    if (!preview?.filePath) return;
    try {
      const newPath = await discoverKeep(result.id, preview.filePath);
      setSavedIds((prev) => new Set(prev).add(result.id));
      // Update the preview state so the player still works with the new path
      setPreviews((prev) => {
        const next = new Map(prev);
        next.set(result.id, { ...preview, filePath: newPath });
        return next;
      });
      // Update player if this track is currently playing
      const player = usePlayerStore.getState();
      if (player.currentTrack?.id === result.id) {
        player.playTrack({
          ...player.currentTrack,
          filePath: newPath,
        });
      }
    } catch (e) {
      console.error("Failed to save track:", e);
    }
  }, [addDownload, destination]);

  // Download a search result directly. Route by source:
  //  - youtube / soundcloud → yt-dlp via `startDownload`
  //  - tidal → tidal-dl-ng via `tidalDownloadMatched`
  //  - spotify → open the Spotify single-track modal so the user can confirm
  //    the Tidal match (may fall back to YouTube) before we kick off the
  //    resolve+download pipeline.
  const handleDirectDownload = useCallback((result: SearchResult) => {
    if (result.source === "tidal") {
      const id = crypto.randomUUID();
      addDownload({
        id,
        url: result.url,
        format: "flac",
        status: "pending",
        progress: 0,
        message: "Starting Tidal download...",
        backend: "tidal-dl-ng",
        title: result.title,
      });
      setSavedIds((prev) => new Set(prev).add(result.id));
      tidalDownloadMatched(
        [{ id, tidal_url: result.url, title: `${result.artist} - ${result.title}` }],
        destination,
      ).catch((e) => console.error("Failed to start Tidal download:", e));
      return;
    }

    if (result.source === "spotify") {
      // Open the existing Spotify single-track modal — the user confirms the
      // Tidal match + download there. Mirrors what pasting a Spotify URL does.
      spotifyFetchTrack(result.url)
        .then((pl) => setSpotifyPlaylist(pl))
        .catch((e) => setSpotifyError(formatErr(e)));
      return;
    }

    const id = crypto.randomUUID();
    addDownload({
      id,
      url: result.url,
      format,
      status: "pending",
      progress: 0,
      message: "Starting...",
      backend: "",
    });
    setSavedIds((prev) => new Set(prev).add(result.id));
    startDownload(id, result.url, format, undefined, destination).catch((e) =>
      console.error("Failed to start download:", e)
    );
  }, [addDownload, format, destination]);

  // Clean up unsaved preview files when results change
  const prevResultsRef = useRef<SearchResult[]>([]);
  useEffect(() => {
    const prevIds = new Set(prevResultsRef.current.map((r) => r.id));
    const currentIds = new Set(searchResults.map((r) => r.id));

    // Trash previews for results that are no longer visible and weren't saved
    for (const id of prevIds) {
      if (currentIds.has(id)) continue;
      if (savedIds.has(id)) continue;
      const preview = previewsRef.current.get(id);
      if (preview?.filePath) {
        discoverTrash(preview.filePath).catch(() => {});
      }
    }

    if (searchResults !== prevResultsRef.current) {
      prevResultsRef.current = searchResults;
    }
  }, [searchResults, savedIds]);

  const [extractingAudio, setExtractingAudio] = useState(false);

  const handleExtractAudio = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Video",
          extensions: ["mp4", "mkv", "webm", "avi", "mov", "flv", "wmv"],
        },
      ],
    });
    if (!selected) return;

    setExtractingAudio(true);
    const id = crypto.randomUUID();
    addDownload({
      id,
      url: selected,
      format: "mp3",
      status: "converting",
      progress: 0,
      message: "Extracting audio...",
      backend: "ffmpeg",
    });

    try {
      await extractAudio(id, selected);
    } catch (e) {
      console.error("Failed to extract audio:", e);
    } finally {
      setExtractingAudio(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  const inputIsUrl = isUrl(url);

  return (
    <>
      <div className="flex items-center gap-3">
        {/* URL input field */}
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search or paste a Tidal / Spotify / YouTube / SoundCloud URL..."
          className="flex-1 rounded-lg border border-[#333] bg-[#111] px-4 py-3 text-sm text-white placeholder-neutral-500 outline-none transition-all duration-200 focus:border-[#555]"
          disabled={extracting || searching}
        />

        {/* Format toggle */}
        <div className="relative flex overflow-hidden rounded-lg border border-[#333] bg-[#111]">
          <button
            onClick={() => setFormat("mp3")}
            className={`relative z-10 px-4 py-3 text-sm font-semibold transition-all duration-200 ${
              format === "mp3"
                ? "bg-[#222] text-white"
                : "text-neutral-600 hover:text-neutral-400"
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Music size={14} />
              M4A
            </span>
          </button>
          <button
            onClick={() => setFormat("mp4")}
            className={`relative z-10 px-4 py-3 text-sm font-semibold transition-all duration-200 ${
              format === "mp4"
                ? "bg-[#222] text-white"
                : "text-neutral-600 hover:text-neutral-400"
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Video size={14} />
              MP4
            </span>
          </button>
        </div>

        {/* Destination toggle — Downloads for ephemeral / meme clips, Music
            for archival library, Song Requests for throwaway tracks we want
            rekordbox to see but don't want to pollute the main library. */}
        <div className="relative flex overflow-hidden rounded-lg border border-[#333] bg-[#111]">
          <button
            onClick={() => setDestination("downloads")}
            className={`relative z-10 px-3 py-3 text-sm font-semibold transition-all duration-200 ${
              destination === "downloads"
                ? "bg-[#222] text-white"
                : "text-neutral-600 hover:text-neutral-400"
            }`}
            title="Save to Downloads folder"
          >
            <span className="flex items-center gap-1.5">
              <FolderDown size={14} />
              Downloads
            </span>
          </button>
          <button
            onClick={() => setDestination("music")}
            className={`relative z-10 px-3 py-3 text-sm font-semibold transition-all duration-200 ${
              destination === "music"
                ? "bg-[#222] text-white"
                : "text-neutral-600 hover:text-neutral-400"
            }`}
            title="Save to Music Library"
          >
            <span className="flex items-center gap-1.5">
              <Library size={14} />
              Music
            </span>
          </button>
          <button
            onClick={() => setDestination("song-requests")}
            className={`relative z-10 px-3 py-3 text-sm font-semibold transition-all duration-200 ${
              destination === "song-requests"
                ? "bg-[#222] text-white"
                : "text-neutral-600 hover:text-neutral-400"
            }`}
            title="Save to <Music>/song-requests/ — throwaway, still scanned by rekordbox"
          >
            <span className="flex items-center gap-1.5">
              <FolderDown size={14} />
              Song Requests
            </span>
          </button>
        </div>

        {/* Download / Search button */}
        <button
          onClick={handleSubmit}
          disabled={!url.trim() || extracting || searching}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {extracting || searching ? (
            <>
              <Loader size={16} className="animate-spin" />
              {searching ? "Searching..." : "Loading..."}
            </>
          ) : inputIsUrl || !url.trim() ? (
            <>
              <Download size={16} />
              Download
            </>
          ) : (
            <>
              <Search size={16} />
              Search
            </>
          )}
        </button>

        {/* Extract MP3 from file button */}
        <button
          onClick={handleExtractAudio}
          disabled={extractingAudio}
          className="flex items-center gap-2 rounded-lg border border-[#333] bg-[#111] px-4 py-3 text-sm font-medium text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          title="Extract MP3 audio from a video file"
        >
          {extractingAudio ? (
            <Loader size={16} className="animate-spin" />
          ) : (
            <FileAudio size={16} />
          )}
        </button>
      </div>

      {/* Tidal auth expired — appears after a background refresh fails. */}
      {tidalAuthExpired && (
        <div className="mt-2 flex items-center justify-between rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-xs text-cyan-200">
          <span>
            Tidal session expired. Re-authenticate in Settings → Tidal to keep using Tidal search &amp; downloads.
          </span>
          <button
            onClick={() => setTidalAuthExpired(false)}
            className="ml-3 text-cyan-300/70 hover:text-cyan-200"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Search source toggles (only affect search queries, not URL downloads) */}
      {!inputIsUrl && (
        <div className="mt-2 flex items-center gap-2 text-xs text-neutral-500">
          <span>Search:</span>
          {tidalAuthed && (
            <button
              onClick={() => toggleSource("tidal")}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
                enabledSources.includes("tidal")
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                  : "border-[#333] bg-transparent text-neutral-500 hover:text-neutral-300"
              }`}
              title="Toggle Tidal as a search source (downloads via tidal-dl-ng, HI_RES_LOSSLESS FLAC)"
            >
              <Waves size={12} />
              Tidal
            </button>
          )}
          {spotifyAuthed && (
            <button
              onClick={() => toggleSource("spotify")}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
                enabledSources.includes("spotify")
                  ? "border-green-500/40 bg-green-500/10 text-green-200"
                  : "border-[#333] bg-transparent text-neutral-500 hover:text-neutral-300"
              }`}
              title="Toggle Spotify as a search source (resolves via Tidal → YouTube)"
            >
              <Disc size={12} />
              Spotify
            </button>
          )}
          <button
            onClick={() => toggleSource("youtube")}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
              enabledSources.includes("youtube")
                ? "border-red-500/40 bg-red-500/10 text-red-200"
                : "border-[#333] bg-transparent text-neutral-500 hover:text-neutral-300"
            }`}
            title="Toggle YouTube as a search source"
          >
            <Youtube size={12} />
            YouTube
          </button>
          <button
            onClick={() => toggleSource("soundcloud")}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors ${
              enabledSources.includes("soundcloud")
                ? "border-orange-500/40 bg-orange-500/10 text-orange-200"
                : "border-[#333] bg-transparent text-neutral-500 hover:text-neutral-300"
            }`}
            title="Toggle SoundCloud as a search source"
          >
            <Cloud size={12} />
            SoundCloud
          </button>
          {enabledSources.length === 0 && (
            <span className="text-red-400/80">No sources selected — searches will return nothing.</span>
          )}
        </div>
      )}

      {/* Playlist preview modal */}
      {playlist && (
        <PlaylistPreview
          playlist={playlist}
          format={format}
          onClose={() => setPlaylist(null)}
        />
      )}

      {/* Spotify playlist preview (routes through Tidal — matching in next step) */}
      {spotifyPlaylist && (
        <SpotifyPlaylistPreview
          playlist={spotifyPlaylist}
          onClose={() => setSpotifyPlaylist(null)}
        />
      )}

      {spotifyError && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          Spotify fetch failed: {spotifyError}
        </div>
      )}

      {/* Search results */}
      <SearchResults
        results={searchResults}
        loading={searching}
        searched={hasSearched}
        previews={previews}
        savedIds={savedIds}
        onPreview={handlePreview}
        onSave={handleSave}
        onDirectDownload={handleDirectDownload}
      />
    </>
  );
}

import { useState, useCallback, useEffect, useRef } from "react";
import { Download, Loader, Music, Video, FileAudio, FolderDown, Library, Search } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePlayerStore } from "../stores/playerStore";
import {
  startDownload, extractPlaylist, extractAudio, searchSources, searchPreview,
  discoverKeep, discoverTrash, spotifyFetchPlaylist, formatErr,
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
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const addDownload = useDownloadStore((s) => s.addDownload);

  const setFormat = (f: "mp4" | "mp3") => updateSetting("format", f);
  const setDestination = (d: "downloads" | "music") =>
    updateSetting("lastDestination", d);

  const handleSubmit = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    if (isUrl(trimmed)) {
      // Clear any search results when switching to URL mode
      setSearchResults([]);
      setHasSearched(false);
      setSpotifyError(null);

      // Spotify playlists route through the Web API → Tidal pipeline,
      // not yt-dlp. Branch first.
      if (isSpotifyPlaylistUrlClient(trimmed)) {
        setExtracting(true);
        try {
          const pl = await spotifyFetchPlaylist(trimmed);
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
      const results = await searchSources(query);
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

  // Listen for search preview status events
  useEffect(() => {
    const unlisten1 = listen<DownloadStatusEvent>("search-preview-status", (e) => {
      const { id, status, progress, message, file_path, cover_art_base64 } = e.payload;
      setPreviews((prev) => {
        const next = new Map(prev);
        const existing = next.get(id) ?? { status: "pending", progress: 0, message: "" };
        if (status === "complete") {
          next.set(id, { ...existing, status: "ready", progress: 100, message: "Ready", filePath: file_path ?? undefined, coverArtBase64: cover_art_base64 ?? undefined });
          // Auto-play the preview
          const results = searchResultsRef.current;
          const result = results.find((r) => r.id === id);
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
    });

    // Also listen to download-status in case yt-dlp emits there
    const unlisten2 = listen<DownloadStatusEvent>("download-status", (e) => {
      const { id } = e.payload;
      if (!previewsRef.current.has(id)) return;
      // Forward to same handler logic
      const { status, progress, message, file_path, cover_art_base64 } = e.payload;
      setPreviews((prev) => {
        const next = new Map(prev);
        const existing = next.get(id) ?? { status: "pending", progress: 0, message: "" };
        if (status === "complete") {
          next.set(id, { ...existing, status: "ready", progress: 100, message: "Ready", filePath: file_path ?? undefined, coverArtBase64: cover_art_base64 ?? undefined });
          const results = searchResultsRef.current;
          const result = results.find((r) => r.id === id);
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
    });

    return () => {
      unlisten1.then((fn) => fn());
      unlisten2.then((fn) => fn());
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

  // Save a previewed track to the output directory
  const handleSave = useCallback(async (result: SearchResult) => {
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
  }, []);

  // Download a search result directly to the output dir (skip preview)
  const handleDirectDownload = useCallback((result: SearchResult) => {
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
          placeholder="Search or paste a YouTube/SoundCloud URL..."
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
              MP3
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

        {/* Destination toggle */}
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

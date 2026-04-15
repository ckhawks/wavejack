import { useState } from "react";
import { Download, Loader, Music, Video, FileAudio, FolderDown, Library } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { startDownload, extractPlaylist, extractAudio } from "../lib/commands";
import { PlaylistPreview } from "./PlaylistPreview";
import type { PlaylistInfo } from "../lib/types";

function isPlaylistUrl(url: string): boolean {
  return (
    url.includes("list=") ||
    url.includes("/playlist") ||
    url.includes("/sets/") ||
    /spotify\.com\/(playlist|album)\//.test(url)
  );
}

export function UrlInput() {
  const [url, setUrl] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null);
  const format = useSettingsStore((s) => s.settings.format);
  const destination = useSettingsStore((s) => s.settings.lastDestination);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const addDownload = useDownloadStore((s) => s.addDownload);

  const setFormat = (f: "mp4" | "mp3") => updateSetting("format", f);
  const setDestination = (d: "downloads" | "music") =>
    updateSetting("lastDestination", d);

  const handleDownload = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

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
    if (e.key === "Enter") handleDownload();
  };

  return (
    <>
      <div className="flex items-center gap-3">
        {/* URL input field */}
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Paste a YouTube or SoundCloud URL..."
          className="flex-1 rounded-lg border border-[#333] bg-[#111] px-4 py-3 text-sm text-white placeholder-neutral-500 outline-none transition-all duration-200 focus:border-[#555]"
          disabled={extracting}
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

        {/* Download button */}
        <button
          onClick={handleDownload}
          disabled={!url.trim() || extracting}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {extracting ? (
            <>
              <Loader size={16} className="animate-spin" />
              Loading...
            </>
          ) : (
            <>
              <Download size={16} />
              Download
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
    </>
  );
}

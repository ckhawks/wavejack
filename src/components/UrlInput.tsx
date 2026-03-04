import { useState } from "react";
import { Download } from "lucide-react";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { startDownload } from "../lib/commands";

export function UrlInput() {
  const [url, setUrl] = useState("");
  const format = useSettingsStore((s) => s.settings.format);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const addDownload = useDownloadStore((s) => s.addDownload);

  const setFormat = (f: "mp4" | "mp3") => updateSetting("format", f);

  const handleDownload = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    // Generate a unique ID for this download
    const id = crypto.randomUUID();

    // Add to the store immediately so it shows up in the queue
    addDownload({
      id,
      url: trimmed,
      format,
      status: "pending",
      progress: 0,
      message: "Starting...",
      backend: "",
    });

    // Clear the input
    setUrl("");

    // Tell the Rust backend to start downloading
    try {
      await startDownload(id, trimmed, format);
    } catch (e) {
      console.error("Failed to start download:", e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleDownload();
  };

  return (
    <div className="flex items-center gap-3">
      {/* URL input field */}
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Paste a YouTube or SoundCloud URL..."
        className="flex-1 rounded-lg border border-[#333] bg-[#111] px-4 py-3 text-sm text-white placeholder-neutral-500 outline-none transition-all duration-200 focus:border-[#555]"
      />

      {/* Format toggle */}
      <div className="relative flex overflow-hidden rounded-lg border border-[#333] bg-[#111]">
        <button
          onClick={() => setFormat("mp4")}
          className={`relative z-10 px-4 py-3 text-sm font-semibold transition-all duration-200 ${
            format === "mp4"
              ? "bg-white text-black shadow-sm"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          <span className="flex items-center gap-1.5">
            {format === "mp4" && <span className="h-1.5 w-1.5 rounded-full bg-black" />}
            MP4
          </span>
        </button>
        <button
          onClick={() => setFormat("mp3")}
          className={`relative z-10 px-4 py-3 text-sm font-semibold transition-all duration-200 ${
            format === "mp3"
              ? "bg-white text-black shadow-sm"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          <span className="flex items-center gap-1.5">
            {format === "mp3" && <span className="h-1.5 w-1.5 rounded-full bg-black" />}
            MP3
          </span>
        </button>
      </div>

      {/* Download button */}
      <button
        onClick={handleDownload}
        disabled={!url.trim()}
        className="flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Download size={16} />
        Download
      </button>
    </div>
  );
}

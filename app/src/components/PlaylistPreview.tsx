import { useState } from "react";
import { X, Download, CheckSquare, Square } from "lucide-react";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { startDownload } from "../lib/commands";
import type { PlaylistInfo } from "../lib/types";

interface Props {
  playlist: PlaylistInfo;
  format: "mp4" | "mp3";
  onClose: () => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlaylistPreview({ playlist, format, onClose }: Props) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(playlist.entries.map((_, i) => i))
  );
  const [downloading, setDownloading] = useState(false);
  const addDownload = useDownloadStore((s) => s.addDownload);
  const destination = useSettingsStore((s) => s.settings.lastDestination);

  const allSelected = selected.size === playlist.entries.length;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(playlist.entries.map((_, i) => i)));
    }
  }

  function toggleEntry(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  async function handleDownload() {
    setDownloading(true);

    const entries = playlist.entries.filter((_, i) => selected.has(i));
    for (const entry of entries) {
      const id = crypto.randomUUID();
      addDownload({
        id,
        url: entry.url,
        format,
        status: "pending",
        progress: 0,
        message: "Starting...",
        backend: "",
        title: entry.title,
        playlistTitle: playlist.title,
      });

      try {
        await startDownload(id, entry.url, format, playlist.title, destination);
      } catch (e) {
        console.error("Failed to start download:", e);
      }

      // Small delay between requests
      await new Promise((r) => setTimeout(r, 200));
    }

    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-[#222] bg-[#111]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#222] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-white">{playlist.title}</h2>
            <p className="mt-0.5 text-xs text-neutral-400">
              {playlist.entries.length} tracks
              {playlist.uploader ? ` · ${playlist.uploader}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* Select all toggle */}
        <div className="flex items-center justify-between border-b border-[#222] px-5 py-2">
          <button
            onClick={toggleAll}
            className="flex items-center gap-2 text-xs text-neutral-400 hover:text-white"
          >
            {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            {allSelected ? "Deselect All" : "Select All"}
          </button>
          <span className="text-xs text-neutral-500">
            {selected.size} selected
          </span>
        </div>

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto">
          {playlist.entries.map((entry, i) => (
            <button
              key={i}
              onClick={() => toggleEntry(i)}
              className="flex w-full items-center gap-3 border-b border-[#1a1a1a] px-5 py-2.5 text-left transition-colors hover:bg-[#1a1a1a]"
            >
              {selected.has(i) ? (
                <CheckSquare size={14} className="shrink-0 text-white" />
              ) : (
                <Square size={14} className="shrink-0 text-neutral-600" />
              )}
              <span className="w-6 shrink-0 text-right text-xs text-neutral-600">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-white">{entry.title}</span>
              {entry.duration != null && (
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatDuration(entry.duration)}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-[#222] px-5 py-3">
          <button
            onClick={handleDownload}
            disabled={selected.size === 0 || downloading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={16} />
            {downloading
              ? "Starting downloads..."
              : `Download ${selected.size} Track${selected.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

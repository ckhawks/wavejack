import { Play, Loader, Download, Check } from "lucide-react";
import { usePlayerStore } from "../stores/playerStore";
import type { SearchResult } from "../lib/types";

export interface PreviewState {
  status: "pending" | "downloading" | "ready" | "error";
  progress: number;
  message: string;
  filePath?: string;
  coverArtBase64?: string;
}

function formatDuration(secs: number): string {
  if (secs <= 0) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function SourceBadge({ source }: { source: SearchResult["source"] }) {
  const styles: Record<SearchResult["source"], { bg: string; text: string; label: string }> = {
    youtube: { bg: "bg-red-900/60", text: "text-red-300", label: "YT" },
    soundcloud: { bg: "bg-orange-900/60", text: "text-orange-300", label: "SC" },
    tidal: { bg: "bg-cyan-900/60", text: "text-cyan-200", label: "TIDAL" },
    spotify: { bg: "bg-green-900/60", text: "text-green-300", label: "SPOT" },
  };
  const s = styles[source];
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function canPreviewSource(source: SearchResult["source"]): boolean {
  // yt-dlp handles youtube/soundcloud; tidal-dl-ng HIGH tier (~96k AAC)
  // handles Tidal previews for near-instant auditioning. Spotify results
  // still don't have a preview backend — they open the match modal instead.
  return source === "youtube" || source === "soundcloud" || source === "tidal";
}

interface SearchResultsProps {
  results: SearchResult[];
  loading: boolean;
  searched: boolean;
  previews: Map<string, PreviewState>;
  savedIds: Set<string>;
  onPreview: (result: SearchResult) => void;
  onSave: (result: SearchResult) => void;
  onDirectDownload: (result: SearchResult) => void;
}

export function SearchResults({
  results,
  loading,
  searched,
  previews,
  savedIds,
  onPreview,
  onSave,
  onDirectDownload,
}: SearchResultsProps) {
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-neutral-500">
        <Loader size={16} className="animate-spin" />
        Searching...
      </div>
    );
  }

  if (searched && results.length === 0) {
    return (
      <p className="py-4 text-sm text-neutral-600">
        No results found. Try a different query.
      </p>
    );
  }

  if (results.length === 0) return null;

  return (
    <div className="mt-2 max-h-[60vh] space-y-1 overflow-y-auto pr-1">
      {results.map((r) => {
        const preview = previews.get(r.id);
        const isSaved = savedIds.has(r.id);
        const isCurrentlyPlaying = currentTrackId === r.id && isPlaying;
        const isDownloading = preview?.status === "downloading";
        const isReady = preview?.status === "ready";
        const previewable = canPreviewSource(r.source);

        return (
          <div
            key={`${r.source}-${r.id}`}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
              isCurrentlyPlaying
                ? "border-violet-500/40 bg-violet-500/5"
                : "border-[#222] bg-[#111] hover:border-[#333]"
            }`}
          >
            {/* Play / Preview button (thumbnail area) */}
            <button
              onClick={() => previewable && onPreview(r)}
              disabled={isDownloading || !previewable}
              className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-[#222] disabled:cursor-not-allowed"
              title={
                !previewable
                  ? "Preview not available for this source — click download"
                  : isReady
                    ? "Play"
                    : "Preview"
              }
            >
              {r.thumbnail_url ? (
                <img
                  src={r.thumbnail_url}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : null}
              {/* Overlay */}
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity hover:opacity-100">
                {isDownloading ? (
                  <Loader size={14} className="animate-spin text-white" />
                ) : (
                  <Play size={14} className="text-white" fill="white" />
                )}
              </div>
              {/* Currently playing indicator */}
              {isCurrentlyPlaying && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <div className="flex gap-0.5">
                    <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: "0ms" }} />
                    <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: "150ms" }} />
                    <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              )}
            </button>

            {/* Title + Artist */}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {r.title}
              </p>
              <div className="flex items-center gap-2">
                <p className="truncate text-xs text-neutral-500">{r.artist}</p>
                {isDownloading && (
                  <span className="shrink-0 text-[10px] text-blue-400">
                    {Math.round(preview.progress)}%
                  </span>
                )}
              </div>
            </div>

            {/* Duration */}
            <span className="shrink-0 text-xs tabular-nums text-neutral-600">
              {formatDuration(r.duration_secs)}
            </span>

            {/* Source badge */}
            <SourceBadge source={r.source} />

            {/* Preview button */}
            <button
              onClick={() => previewable && onPreview(r)}
              disabled={isDownloading || !previewable}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                isCurrentlyPlaying
                  ? "border-violet-500/50 text-violet-400 hover:border-violet-400"
                  : "border-[#333] text-neutral-400 hover:border-[#555] hover:text-white"
              }`}
              title={
                !previewable
                  ? "Preview not available for this source"
                  : isReady
                    ? "Play"
                    : "Preview"
              }
            >
              {isDownloading ? (
                <Loader size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
            </button>

            {/* Download / Save button */}
            {isSaved ? (
              <button
                disabled
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-green-900/40 px-3 py-1.5 text-xs font-medium text-green-400"
              >
                <Check size={12} />
                Saved
              </button>
            ) : isReady ? (
              <button
                onClick={() => onSave(r)}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-neutral-200"
                title="Save to downloads"
              >
                <Download size={12} />
                Save
              </button>
            ) : (
              <button
                onClick={() => onDirectDownload(r)}
                disabled={isDownloading}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
                title="Download directly"
              >
                <Download size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Plus, X, Loader, Play, Download, Rss } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useFeedStore } from "../stores/feedStore";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import { usePlayerStore } from "../stores/playerStore";
import { startDownload, searchPreview } from "../lib/commands";
import type { FeedItem } from "../lib/types";
import type { DownloadStatusEvent } from "../lib/types";
import { FeedDownloadDialog } from "./FeedDownloadDialog";

interface PreviewState {
  status: "downloading" | "ready" | "error";
  progress: number;
  filePath?: string;
  coverArtBase64?: string;
}

function formatDuration(secs: number): string {
  if (secs <= 0) return "";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatUploadDate(dateStr: string): string {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const d = dateStr.slice(6, 8);
  const date = new Date(`${y}-${m}-${d}`);
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff}d ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  if (diff < 365) return `${Math.floor(diff / 30)}mo ago`;
  return `${y}-${m}-${d}`;
}

export function FeedView() {
  const subscriptions = useFeedStore((s) => s.subscriptions);
  const refreshing = useFeedStore((s) => s.refreshing);
  const adding = useFeedStore((s) => s.adding);
  const channelFilter = useFeedStore((s) => s.channelFilter);
  const setChannelFilter = useFeedStore((s) => s.setChannelFilter);
  const addChannel = useFeedStore((s) => s.addChannel);
  const removeChannel = useFeedStore((s) => s.removeChannel);
  const refresh = useFeedStore((s) => s.refresh);
  const reloadItems = useFeedStore((s) => s.reloadItems);
  const filteredItems = useFeedStore((s) => s.filteredItems);

  const format = useSettingsStore((s) => s.settings.format);
  const destination = useSettingsStore((s) => s.settings.lastDestination);
  const addDownload = useDownloadStore((s) => s.addDownload);

  const [url, setUrl] = useState("");
  const [previews, setPreviews] = useState<Map<string, PreviewState>>(new Map());
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [dialogItem, setDialogItem] = useState<FeedItem | null>(null);

  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  // Init on mount
  useEffect(() => {
    useFeedStore.getState().init();
  }, []);

  // Listen for feed refresh progress
  useEffect(() => {
    const unlisten = listen<{ done: number; total: number; finished?: boolean }>(
      "feed-refresh-progress",
      (e) => {
        if (e.payload.finished) {
          useFeedStore.setState({ refreshing: false });
          reloadItems();
        }
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [reloadItems]);

  // Listen for search preview events (reuse same channel as search)
  useEffect(() => {
    const handler = (payload: DownloadStatusEvent) => {
      const { id, status, progress, file_path, cover_art_base64 } = payload;
      setPreviews((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        const existing = next.get(id)!;
        if (status === "complete") {
          next.set(id, { ...existing, status: "ready", progress: 100, filePath: file_path ?? undefined, coverArtBase64: cover_art_base64 ?? undefined });
          // Auto-play
          const items = useFeedStore.getState().items;
          const item = items.find((i) => i.video_id === id);
          if (item && file_path) {
            usePlayerStore.getState().playTrack({
              id: item.video_id,
              title: item.title,
              artist: item.uploader,
              filePath: file_path,
              coverArtBase64: cover_art_base64 ?? undefined,
            });
          }
        } else if (status === "error") {
          next.set(id, { ...existing, status: "error", progress: 0 });
        } else {
          next.set(id, { ...existing, status: "downloading", progress });
        }
        return next;
      });
    };

    const u1 = listen<DownloadStatusEvent>("search-preview-status", (e) => handler(e.payload));
    const u2 = listen<DownloadStatusEvent>("download-status", (e) => {
      if (previews.has(e.payload.id)) handler(e.payload);
    });
    return () => { u1.then((fn) => fn()); u2.then((fn) => fn()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    await addChannel(trimmed);
    setUrl("");
  };

  const handlePreview = useCallback((item: FeedItem) => {
    const existing = previews.get(item.video_id);
    if (existing?.status === "ready" && existing.filePath) {
      usePlayerStore.getState().playTrack({
        id: item.video_id,
        title: item.title,
        artist: item.uploader,
        filePath: existing.filePath,
        coverArtBase64: existing.coverArtBase64,
      });
      return;
    }
    if (existing?.status === "downloading") return;

    setPreviews((prev) => {
      const next = new Map(prev);
      next.set(item.video_id, { status: "downloading", progress: 0 });
      return next;
    });
    searchPreview(item.video_id, item.url, item.title).catch((e) =>
      console.error("Preview failed:", e)
    );
  }, [previews]);

  const runYoutubeDownload = useCallback((item: FeedItem) => {
    const id = crypto.randomUUID();
    addDownload({
      id,
      url: item.url,
      format,
      status: "pending",
      progress: 0,
      message: "Starting...",
      backend: "",
    });
    setDownloadedIds((prev) => new Set(prev).add(item.video_id));
    startDownload(id, item.url, format, undefined, destination).catch((e) =>
      console.error("Download failed:", e)
    );
  }, [addDownload, format, destination]);

  const handleDownload = useCallback((item: FeedItem) => {
    setDialogItem(item);
  }, []);

  const items = filteredItems();

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      {/* Add channel input */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          placeholder="Paste a YouTube channel URL or @handle..."
          className="flex-1 rounded-lg border border-[#333] bg-[#111] px-4 py-3 text-sm text-white placeholder-neutral-500 outline-none transition-all duration-200 focus:border-[#555]"
          disabled={adding}
        />
        <button
          onClick={handleAdd}
          disabled={!url.trim() || adding}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {adding ? <Loader size={16} className="animate-spin" /> : <Plus size={16} />}
          Subscribe
        </button>
        <button
          onClick={refresh}
          disabled={refreshing || subscriptions.length === 0}
          className="flex items-center gap-2 rounded-lg border border-[#333] bg-[#111] px-4 py-3 text-sm font-medium text-neutral-400 transition-all hover:border-[#555] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Subscription chips */}
      {subscriptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setChannelFilter(null)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              channelFilter === null
                ? "bg-white text-black"
                : "bg-[#222] text-neutral-400 hover:text-white"
            }`}
          >
            All
          </button>
          {subscriptions.map((sub) => (
            <div
              key={sub.id}
              className={`group flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${
                channelFilter === sub.id
                  ? "bg-white text-black"
                  : "bg-[#222] text-neutral-400 hover:text-white"
              }`}
            >
              <button onClick={() => setChannelFilter(channelFilter === sub.id ? null : sub.id)}>
                {sub.name}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); removeChannel(sub.id); }}
                className="opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Feed list */}
      <div className="flex-1 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-neutral-500">
            <Rss size={32} />
            <p className="text-sm">
              {subscriptions.length === 0
                ? "Subscribe to YouTube channels to see their latest uploads"
                : "No uploads yet — click Refresh to fetch"}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => {
              const preview = previews.get(item.video_id);
              const isDownloaded = downloadedIds.has(item.video_id);
              const isCurrentlyPlaying = currentTrackId === item.video_id && isPlaying;
              const isDownloading = preview?.status === "downloading";

              return (
                <div
                  key={item.video_id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
                    isCurrentlyPlaying
                      ? "border-violet-500/40 bg-violet-500/5"
                      : "border-[#222] bg-[#111] hover:border-[#333]"
                  }`}
                >
                  {/* Thumbnail — clickable to preview */}
                  <button
                    onClick={() => handlePreview(item)}
                    disabled={isDownloading}
                    className="relative h-16 w-28 shrink-0 overflow-hidden rounded bg-[#222]"
                  >
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt="" className="h-full w-full object-cover" />
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity hover:opacity-100">
                      {isDownloading ? (
                        <Loader size={16} className="animate-spin text-white" />
                      ) : (
                        <Play size={16} className="text-white" fill="white" />
                      )}
                    </div>
                    {isCurrentlyPlaying && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                        <div className="flex gap-0.5">
                          <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: "0ms" }} />
                          <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: "150ms" }} />
                          <span className="inline-block h-3 w-0.5 animate-pulse rounded-full bg-violet-400" style={{ animationDelay: "300ms" }} />
                        </div>
                      </div>
                    )}
                    {/* Duration badge */}
                    {item.duration > 0 && (
                      <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[10px] tabular-nums text-white">
                        {formatDuration(item.duration)}
                      </span>
                    )}
                  </button>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{item.title}</p>
                    <p className="truncate text-xs text-neutral-500">
                      {item.uploader}
                      {item.upload_date && (
                        <span className="ml-2 text-neutral-600">{formatUploadDate(item.upload_date)}</span>
                      )}
                    </p>
                    {isDownloading && (
                      <span className="text-[10px] text-blue-400">{Math.round(preview.progress)}%</span>
                    )}
                  </div>

                  {/* Preview button */}
                  <button
                    onClick={() => handlePreview(item)}
                    disabled={isDownloading}
                    className={`flex shrink-0 items-center rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      isCurrentlyPlaying
                        ? "border-violet-500/50 text-violet-400"
                        : "border-[#333] text-neutral-400 hover:border-[#555] hover:text-white"
                    }`}
                  >
                    {isDownloading ? <Loader size={12} className="animate-spin" /> : <Play size={12} />}
                  </button>

                  {/* Download button */}
                  <button
                    onClick={() => handleDownload(item)}
                    disabled={isDownloaded}
                    className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      isDownloaded
                        ? "bg-green-900/40 text-green-400"
                        : "bg-white text-black hover:bg-neutral-200"
                    }`}
                  >
                    <Download size={12} />
                    {isDownloaded ? "Downloading" : ""}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dialogItem && (
        <FeedDownloadDialog
          item={dialogItem}
          onUseYoutube={() => runYoutubeDownload(dialogItem)}
          onDownloaded={() => {
            setDownloadedIds((prev) => new Set(prev).add(dialogItem.video_id));
            setDialogItem(null);
          }}
          onClose={() => setDialogItem(null)}
        />
      )}
    </div>
  );
}

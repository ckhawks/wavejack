import { useCallback, useEffect, useState } from "react";
import { Music, Play, RotateCw, Clock } from "lucide-react";
import { getRecentlyPlayed, type PlayHistoryEntry } from "../lib/commands";
import { usePlayerStore } from "../stores/playerStore";

/** Relative "time ago" for a unix-seconds timestamp. */
function relativeTime(unixSecs: number): string {
  if (!unixSecs) return "—";
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo ago`;
  return `${Math.floor(diff / (86400 * 365))}y ago`;
}

function absoluteDate(unixSecs: number): string {
  if (!unixSecs) return "";
  return new Date(unixSecs * 1000).toLocaleString();
}

export function RecentlyPlayedView() {
  const [entries, setEntries] = useState<PlayHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const playTrack = usePlayerStore((s) => s.playTrack);
  // Refetch whenever a new track starts so the list stays live while on this tab.
  const currentId = usePlayerStore((s) => s.currentTrack?.id);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await getRecentlyPlayed(200);
      setEntries(rows);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, currentId]);

  const handlePlay = (entry: PlayHistoryEntry) => {
    // Queue up the recent list from this point forward so "next" walks it.
    const idx = entries.findIndex((e) => e.id === entry.id);
    usePlayerStore.getState().setQueue(
      entries.slice(idx).map((e) => ({
        id: e.track.path,
        title: e.track.title,
        artist: e.track.artist,
        filePath: e.track.path,
        coverArtBase64: e.track.cover_art_base64 || undefined,
        durationSecs: e.track.duration_secs || undefined,
      })),
    );
    playTrack({
      id: entry.track.path,
      title: entry.track.title,
      artist: entry.track.artist,
      filePath: entry.track.path,
      coverArtBase64: entry.track.cover_art_base64 || undefined,
      durationSecs: entry.track.duration_secs || undefined,
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-[#222] px-6 py-3">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-neutral-400" />
          <h2 className="text-sm font-semibold text-white">Recently Played</h2>
          {!loading && entries.length > 0 && (
            <span className="text-xs text-neutral-500">{entries.length}</span>
          )}
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-400 transition-colors hover:bg-[#222] hover:text-white"
          title="Refresh"
        >
          <RotateCw size={12} />
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="px-6 py-8 text-sm text-red-400">{error}</div>
        ) : loading && entries.length === 0 ? (
          <div className="px-6 py-8 text-sm text-neutral-500">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <Music size={28} className="text-neutral-700" />
            <p className="text-sm text-neutral-400">Nothing played yet</p>
            <p className="text-xs text-neutral-600">
              Songs you play from your library will show up here.
            </p>
          </div>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="group flex items-center gap-3 px-6 py-2 hover:bg-[#151515]"
              >
                <div className="relative h-10 w-10 shrink-0">
                  {entry.track.cover_art_base64 ? (
                    <img
                      src={`data:image/jpeg;base64,${entry.track.cover_art_base64}`}
                      alt=""
                      className="h-10 w-10 rounded object-cover transition-opacity group-hover:opacity-50"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded bg-[#1a1a1a] transition-opacity group-hover:opacity-50">
                      <Music size={14} className="text-neutral-700" />
                    </div>
                  )}
                  <button
                    onClick={() => handlePlay(entry)}
                    className="absolute inset-0 flex items-center justify-center rounded text-white opacity-0 transition-opacity hover:bg-black/30 group-hover:opacity-100"
                    title="Play"
                  >
                    <Play size={16} fill="currentColor" />
                  </button>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white">
                    {entry.track.title || entry.track.filename}
                  </div>
                  <div className="truncate text-xs text-neutral-500">
                    {entry.track.artist || "Unknown artist"}
                  </div>
                </div>

                <div
                  className="shrink-0 text-xs text-neutral-500"
                  title={absoluteDate(entry.played_at)}
                >
                  {relativeTime(entry.played_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

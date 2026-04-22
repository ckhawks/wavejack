import { X, Music, Hash } from "lucide-react";
import type { SpotifyPlaylist } from "../lib/types";

interface Props {
  playlist: SpotifyPlaylist;
  onClose: () => void;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function SpotifyPlaylistPreview({ playlist, onClose }: Props) {
  const withIsrc = playlist.tracks.filter((t) => t.isrc).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-[#222] bg-[#111]">
        <div className="flex items-center justify-between border-b border-[#222] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{playlist.name}</h2>
            <p className="mt-0.5 truncate text-xs text-neutral-400">
              {playlist.owner ? `${playlist.owner} · ` : ""}
              {playlist.tracks.length} tracks · {withIsrc} with ISRC
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {playlist.tracks.map((t, i) => (
            <div
              key={t.id}
              className="flex items-center gap-3 border-b border-[#1a1a1a] px-5 py-2.5"
            >
              <span className="w-6 shrink-0 text-right text-xs text-neutral-600">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">{t.name}</div>
                <div className="truncate text-xs text-neutral-500">
                  {t.artists.join(", ")}
                  {t.album ? ` · ${t.album}` : ""}
                </div>
              </div>
              {t.isrc ? (
                <span
                  className="flex shrink-0 items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400"
                  title="Has ISRC — exact Tidal match likely"
                >
                  <Hash size={10} />
                  {t.isrc}
                </span>
              ) : (
                <span
                  className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400"
                  title="No ISRC — will fall back to fuzzy match"
                >
                  no ISRC
                </span>
              )}
              <span className="w-10 shrink-0 text-right text-xs text-neutral-500">
                {formatDuration(t.duration_ms)}
              </span>
            </div>
          ))}
        </div>

        <div className="border-t border-[#222] px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <Music size={12} />
            Tidal matching and download coming in the next step.
          </div>
        </div>
      </div>
    </div>
  );
}

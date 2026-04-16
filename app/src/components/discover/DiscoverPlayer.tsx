import { Check, X, Loader, SkipForward, Trash2, Cloud, Radio, Youtube } from "lucide-react";
import { useDiscoverStore } from "../../stores/discoverStore";
import { usePlayerStore } from "../../stores/playerStore";
import type { DiscoverItem } from "../../lib/types";

const sourceConfig: Record<DiscoverItem["source"], { icon: typeof Radio; label: string; color: string }> = {
  lastfm: { icon: Radio, label: "Last.fm", color: "bg-red-500/15 text-red-400" },
  soundcloud: { icon: Cloud, label: "SoundCloud", color: "bg-orange-500/15 text-orange-400" },
  youtube: { icon: Youtube, label: "YouTube", color: "bg-red-600/15 text-red-300" },
};

function SourceBadge({ source }: { source: DiscoverItem["source"] }) {
  const cfg = sourceConfig[source];
  const Icon = cfg.icon;
  return (
    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${cfg.color}`}>
      <Icon size={10} />
      {cfg.label}
    </span>
  );
}

function SourceIcon({ source }: { source: DiscoverItem["source"] }) {
  const cfg = sourceConfig[source];
  const Icon = cfg.icon;
  const colorClass = cfg.color.split(" ")[1]; // extract text color
  return <Icon size={10} className={`shrink-0 ${colorClass}`} />;
}

export function DiscoverPlayer() {
  const queue = useDiscoverStore((s) => s.queue);
  const currentIndex = useDiscoverStore((s) => s.currentIndex);
  const approveCurrent = useDiscoverStore((s) => s.approveCurrent);
  const skipCurrent = useDiscoverStore((s) => s.skipCurrent);
  const clearQueue = useDiscoverStore((s) => s.clearQueue);
  const playCurrent = useDiscoverStore((s) => s.playCurrent);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTrack = usePlayerStore((s) => s.currentTrack);

  const item = queue[currentIndex];
  const isFinished = currentIndex >= queue.length;

  if (isFinished) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-lg font-medium text-white">All done!</p>
        <p className="text-sm text-neutral-500">
          You've gone through all {queue.length} recommendations.
        </p>
        <button
          onClick={clearQueue}
          className="rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200"
        >
          Start Over
        </button>
      </div>
    );
  }

  if (!item) return null;

  const isCurrentPlaying = currentTrack?.id === item.id && isPlaying;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6">
      {/* Progress counter */}
      <div className="flex w-full items-center justify-between px-2">
        <span className="text-xs text-neutral-600">
          Track {currentIndex + 1} of {queue.length}
        </span>
        <button
          onClick={clearQueue}
          className="flex items-center gap-1 text-xs text-neutral-600 transition-colors hover:text-neutral-400"
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>

      {/* Track card */}
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-[#222] bg-[#111] p-6">
        {/* Cover art */}
        {item.coverArtBase64 ? (
          <img
            src={`data:image/jpeg;base64,${item.coverArtBase64}`}
            alt=""
            className="h-48 w-48 rounded-lg object-cover shadow-lg"
          />
        ) : (
          <div className="flex h-48 w-48 items-center justify-center rounded-lg bg-[#222] text-neutral-600">
            {item.status === "downloading" ? (
              <Loader size={32} className="animate-spin" />
            ) : (
              <span className="text-4xl">?</span>
            )}
          </div>
        )}

        {/* Track info */}
        <div className="text-center">
          <p className="text-lg font-semibold text-white">{item.title}</p>
          <p className="mt-1 text-sm text-neutral-400">{item.artist}</p>
          <div className="mt-2 flex items-center justify-center gap-2">
            <SourceBadge source={item.source} />
            <span className="text-xs text-neutral-600">
              {Math.round(item.matchScore * 100)}% match
            </span>
          </div>
        </div>

        {/* Status message */}
        {item.status === "downloading" && (
          <div className="w-full">
            <div className="mb-1 flex items-center justify-center gap-2 text-xs text-blue-400">
              <Loader size={12} className="animate-spin" />
              {item.message}
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[#222]">
              <div
                className="h-full rounded-full bg-blue-400 transition-all duration-300"
                style={{ width: `${Math.min(item.progress, 100)}%` }}
              />
            </div>
          </div>
        )}

        {item.status === "error" && (
          <p className="text-xs text-red-400">{item.message}</p>
        )}

        {/* Play button for ready tracks */}
        {item.status === "ready" && !isCurrentPlaying && (
          <button
            onClick={playCurrent}
            className="rounded-lg bg-white px-6 py-2 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200"
          >
            Play
          </button>
        )}

        {isCurrentPlaying && (
          <p className="text-xs text-green-400">Now playing...</p>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-4">
        <button
          onClick={skipCurrent}
          className="flex h-14 w-14 items-center justify-center rounded-full border border-[#333] bg-[#111] text-neutral-400 transition-all duration-200 hover:border-red-500/50 hover:text-red-400"
          title="Skip"
        >
          <X size={24} />
        </button>

        {(item.status === "error" || item.message === "Kept!") && (
          <button
            onClick={skipCurrent}
            className="flex h-12 w-12 items-center justify-center rounded-full border border-[#333] bg-[#111] text-neutral-400 transition-all duration-200 hover:border-[#555] hover:text-white"
            title="Next"
          >
            <SkipForward size={20} />
          </button>
        )}

        <button
          onClick={approveCurrent}
          disabled={item.status !== "ready" || item.message === "Kept!"}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-30"
          title="Approve (keep)"
        >
          <Check size={24} />
        </button>
      </div>

      {/* Upcoming queue preview */}
      {currentIndex + 1 < queue.length && (
        <div className="w-full max-w-sm">
          <p className="mb-2 text-xs font-medium text-neutral-600">Up next</p>
          <div className="space-y-1">
            {queue.slice(currentIndex + 1, currentIndex + 4).map((q) => (
              <div
                key={q.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-xs"
              >
                <SourceIcon source={q.source} />
                <span className="truncate text-neutral-400">
                  {q.artist} - {q.title}
                </span>
                {q.status === "downloading" && (
                  <Loader size={10} className="shrink-0 animate-spin text-blue-400" />
                )}
                {q.status === "ready" && (
                  <span className="shrink-0 text-green-400">ready</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

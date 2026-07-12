import { useState } from "react";
import { X, Play, GripVertical, ListMusic } from "lucide-react";
import { usePlayerStore } from "../stores/playerStore";

/** Floating "Up Next" list, anchored above the player bar. Shows the queued
 * tracks after the current one; supports click-to-jump, remove, and
 * drag-to-reorder. Indices passed to the store are absolute queue positions. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const queue = usePlayerStore((s) => s.queue);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const reorderQueue = usePlayerStore((s) => s.reorderQueue);
  const clearQueue = usePlayerStore((s) => s.clearQueue);

  // Track the row being dragged (absolute queue index) so drop knows the source.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const currentIndex = currentTrack
    ? queue.findIndex((t) => t.id === currentTrack.id)
    : -1;
  // Everything after the current track. If current isn't in the queue there's
  // nothing meaningful queued ahead.
  const upcoming =
    currentIndex >= 0
      ? queue.slice(currentIndex + 1).map((t, i) => ({ track: t, index: currentIndex + 1 + i }))
      : [];

  const handleDrop = (targetIndex: number) => {
    if (dragIndex !== null && dragIndex !== targetIndex) {
      reorderQueue(dragIndex, targetIndex);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="fixed bottom-24 right-4 z-50 flex max-h-[60vh] w-80 flex-col rounded-lg border border-[#333] bg-[#0a0a0a] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[#222] px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-white">
          <ListMusic size={13} className="text-violet-400" />
          Up Next
          {upcoming.length > 0 && (
            <span className="text-neutral-500">({upcoming.length})</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {upcoming.length > 0 && (
            <button
              onClick={clearQueue}
              className="rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:text-white"
              title="Clear the queue"
            >
              Clear
            </button>
          )}
          <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:text-white" title="Close">
            <X size={13} />
          </button>
        </div>
      </div>

      {currentTrack && (
        <div className="flex items-center gap-2 border-b border-[#222] bg-[#141414] px-3 py-2">
          <Thumb base64={currentTrack.coverArtBase64} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-violet-400">{currentTrack.title}</p>
            <p className="truncate text-[11px] text-neutral-500">{currentTrack.artist || "—"}</p>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-neutral-600">Now</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-[#333] [&::-webkit-scrollbar]:w-2">
        {upcoming.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-neutral-600">
            Nothing queued. Use a track's ⋯ menu to “Play next” or “Add to queue”.
          </p>
        ) : (
          upcoming.map(({ track, index }) => (
            <div
              key={`${track.id}:${index}`}
              draggable
              onDragStart={(e) => {
                // Chromium only fires `drop` when a drag payload is set.
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(index));
                setDragIndex(index);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOverIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(index);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={`group flex items-center gap-2 px-2 py-1.5 ${
                overIndex === index && dragIndex !== index ? "bg-violet-600/10" : "hover:bg-[#141414]"
              } ${dragIndex === index ? "opacity-40" : ""}`}
            >
              <GripVertical
                size={13}
                className="shrink-0 cursor-grab text-neutral-700 group-hover:text-neutral-500"
              />
              <button
                onClick={() => playTrack(track)}
                className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded bg-[#222]"
                title="Play now"
              >
                <Thumb base64={track.coverArtBase64} />
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                  <Play size={12} fill="currentColor" className="text-white" />
                </span>
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-neutral-200">{track.title}</p>
                <p className="truncate text-[11px] text-neutral-500">{track.artist || "—"}</p>
              </div>
              <button
                onClick={() => removeFromQueue(track.id)}
                className="shrink-0 rounded p-1 text-neutral-600 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                title="Remove from queue"
              >
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Thumb({ base64 }: { base64?: string }) {
  if (!base64) {
    return <div className="h-8 w-8 shrink-0 rounded bg-[#222]" />;
  }
  return (
    <img
      src={`data:image/jpeg;base64,${base64}`}
      alt=""
      draggable={false}
      className="h-8 w-8 shrink-0 rounded object-cover"
    />
  );
}

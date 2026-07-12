import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Image as ImageIcon, Wand2, Pencil, Compass, Loader, ListStart, ListEnd } from "lucide-react";
import type { LibraryTrack } from "../../lib/commands";
import { usePlayerStore } from "../../stores/playerStore";
import { playerTrackFromLibrary } from "./libraryShared";

interface TrackActionsMenuProps {
  track: LibraryTrack;
  isFindingArt: boolean;
  onFindArt: () => void;
  onAutoTag: () => void;
  onEdit: () => void;
  onDiscoverSimilar: () => void;
}

export function TrackActionsMenu({
  track,
  isFindingArt,
  onFindArt,
  onAutoTag,
  onEdit,
  onDiscoverSimilar,
}: TrackActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queueNext = usePlayerStore((s) => s.queueNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const run = (action: () => void) => () => {
    action();
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:text-white"
        title="More actions"
      >
        <MoreHorizontal size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded border border-[#333] bg-[#0a0a0a] py-1 shadow-xl">
          <button
            onClick={run(() => queueNext(playerTrackFromLibrary(track)))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
          >
            <ListStart size={12} />
            Play next
          </button>
          <button
            onClick={run(() => addToQueue(playerTrackFromLibrary(track)))}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
          >
            <ListEnd size={12} />
            Add to queue
          </button>
          <div className="mx-2 my-1 border-t border-[#222]" />
          {!track.cover_art_base64 && (
            <button
              onClick={run(onFindArt)}
              disabled={isFindingArt}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white disabled:opacity-50"
            >
              {isFindingArt ? <Loader size={12} className="animate-spin" /> : <ImageIcon size={12} />}
              Find album art
            </button>
          )}
          <button
            onClick={run(onAutoTag)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
          >
            <Wand2 size={12} />
            Auto-tag (MusicBrainz)
          </button>
          <button
            onClick={run(onEdit)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
          >
            <Pencil size={12} />
            Edit metadata
          </button>
          {track.artist && (
            <button
              onClick={run(onDiscoverSimilar)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-violet-300"
            >
              <Compass size={12} />
              Discover similar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

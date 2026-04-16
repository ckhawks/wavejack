import { useState, useRef, useEffect } from "react";
import { ListPlus } from "lucide-react";
import { usePlaylistStore } from "../../stores/playlistStore";

interface AddToPlaylistMenuProps {
  trackPath: string;
}

export function AddToPlaylistMenu({ trackPath }: AddToPlaylistMenuProps) {
  const playlists = usePlaylistStore((s) => s.playlists);
  const addTracks = usePlaylistStore((s) => s.addTracks);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleAdd = async (playlistId: string) => {
    await addTracks(playlistId, [trackPath]);
    setOpen(false);
  };

  if (playlists.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:text-white"
        title="Add to playlist"
      >
        <ListPlus size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[140px] rounded border border-[#333] bg-[#0a0a0a] py-1 shadow-xl">
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => handleAdd(p.id)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-neutral-300 transition-colors hover:bg-[#1a1a1a] hover:text-white"
            >
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

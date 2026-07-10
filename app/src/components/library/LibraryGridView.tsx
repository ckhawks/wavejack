import { Music, Play } from "lucide-react";
import { AddToPlaylistMenu } from "./AddToPlaylistMenu";
import { TrackActionsMenu } from "./TrackActionsMenu";
import type { LibraryListProps } from "./libraryShared";

/** Art-forward tile grid. Metadata is minimal (title + artist); sorting by any
 * stat is still available through the shared sort control in the toolbar. */
export function LibraryGridView({
  tracks,
  currentTrackId,
  selectedPaths,
  onRowClick,
  onPlay,
  findingArtFor,
  onFindArt,
  onAutoTag,
  onEdit,
  onDiscoverSimilar,
}: LibraryListProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 px-6 pb-4">
      {tracks.map((track) => {
        const isActive = currentTrackId === track.path;
        const isSelected = selectedPaths.has(track.path);
        return (
          <div
            key={track.path}
            onClick={(e) => onRowClick(track.path, e)}
            onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
            onDragStart={(e) => e.preventDefault()}
            className={`group relative cursor-default select-none rounded-lg p-2 transition-colors hover:bg-[#141414] ${
              isSelected
                ? "bg-violet-600/10 ring-1 ring-inset ring-violet-500/30"
                : isActive ? "bg-[#141414]" : ""
            }`}
          >
            {/* Cover */}
            <div className="relative mb-2 aspect-square w-full overflow-hidden rounded-md bg-[#1a1a1a]">
              {track.cover_art_base64 ? (
                <img
                  src={`data:image/jpeg;base64,${track.cover_art_base64}`}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Music size={28} className="text-neutral-700" />
                </div>
              )}
              <button
                onClick={() => onPlay(track)}
                className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition-opacity hover:bg-black/50 group-hover:opacity-100"
                title="Play"
              >
                <Play size={28} fill="currentColor" />
              </button>
            </div>

            {/* Per-track actions, top-right on hover. Sits on the card (not the
                clipped cover) so its popover isn't cut off. */}
            <div
              className="absolute right-3 top-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <AddToPlaylistMenu trackPath={track.path} />
              <TrackActionsMenu
                track={track}
                isFindingArt={findingArtFor === track.path}
                onFindArt={() => onFindArt(track)}
                onAutoTag={() => onAutoTag(track)}
                onEdit={() => onEdit(track)}
                onDiscoverSimilar={() => onDiscoverSimilar(track)}
              />
            </div>

            {/* Title + artist */}
            <div className="min-w-0 px-0.5">
              <div className={`truncate text-xs ${isActive ? "text-violet-400" : "text-white"}`} title={track.title}>
                {track.title || track.filename}
              </div>
              <div className="truncate text-[11px] text-neutral-500" title={track.artist}>
                {track.artist || "—"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { Play } from "lucide-react";
import { AddToPlaylistMenu } from "./AddToPlaylistMenu";
import { TrackActionsMenu } from "./TrackActionsMenu";
import { formatDuration, type LibraryListProps } from "./libraryShared";

/** Single-line rows: title and artist inline, with the cover art bleeding in
 * faded behind each row. Denser and more visual than the table. */
export function LibraryCompactView({
  tracks,
  currentTrackId,
  selectedPaths,
  onRowClick,
  onPlay,
  tagFilter,
  onTagClick,
  findingArtFor,
  onFindArt,
  onAutoTag,
  onEdit,
  onDiscoverSimilar,
}: LibraryListProps) {
  return (
    <div className="flex flex-col gap-px px-3">
      {tracks.map((track) => {
        const isActive = currentTrackId === track.path;
        const isSelected = selectedPaths.has(track.path);
        return (
          <div
            key={track.path}
            onClick={(e) => onRowClick(track.path, e)}
            onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
            onDragStart={(e) => e.preventDefault()}
            className={`group relative flex h-11 cursor-default select-none items-center gap-3 rounded px-3 text-xs hover:bg-[#141414] ${
              isSelected
                ? "bg-violet-600/10 ring-1 ring-inset ring-violet-500/20"
                : isActive ? "bg-[#141414]" : ""
            }`}
          >
            {/* Full-bleed cover art tinting the whole row, with a scrim that
                stays darkest on the left to keep the title/artist legible.
                Clipping lives on this wrapper (not the row) so hover popovers
                can overflow. */}
            {track.cover_art_base64 && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden rounded">
                <img
                  src={`data:image/jpeg;base64,${track.cover_art_base64}`}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover opacity-60 transition-opacity group-hover:opacity-75"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0a]/90 via-[#0a0a0a]/35 to-transparent" />
              </div>
            )}

            {/* Play affordance */}
            <button
              onClick={() => onPlay(track)}
              className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-white/10 hover:text-white"
              title="Play"
            >
              {isActive ? (
                <Play size={13} fill="currentColor" className="text-violet-400" />
              ) : (
                <Play size={13} fill="currentColor" />
              )}
            </button>

            {/* Title / artist inline */}
            <div className="relative flex min-w-0 flex-1 items-baseline gap-3 tracking-wide">
              <span className={`truncate ${isActive ? "text-violet-400" : "text-white"}`}>
                {track.title || track.filename}
              </span>
              <span className="truncate text-[11px] text-neutral-500">{track.artist || "—"}</span>
            </div>

            {/* Tags (first couple) */}
            <div className="relative hidden shrink-0 items-center gap-1 md:flex">
              {track.tags.slice(0, 2).map((tag) => (
                <button
                  key={tag}
                  onClick={() => onTagClick(tag)}
                  className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                    tagFilter === tag
                      ? "bg-violet-600/20 text-violet-300 ring-1 ring-violet-500/40"
                      : "bg-[#1a1a1a]/80 text-neutral-500 hover:bg-violet-600/10 hover:text-violet-300"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>

            {/* Duration */}
            <span className="relative w-10 shrink-0 text-right tabular-nums text-neutral-500">
              {formatDuration(track.duration_secs)}
            </span>

            {/* Actions on hover */}
            <div className="relative flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
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
          </div>
        );
      })}
    </div>
  );
}

import { Music, Play, ArrowUp, ArrowDown } from "lucide-react";
import { AddToPlaylistMenu } from "./AddToPlaylistMenu";
import { TrackActionsMenu } from "./TrackActionsMenu";
import {
  relativeTime,
  absoluteDate,
  formatDuration,
  typeMismatch,
  type ColumnKey,
  type SortState,
  type LibraryListProps,
} from "./libraryShared";

interface LibraryTableViewProps extends LibraryListProps {
  columns: Record<ColumnKey, boolean>;
  sort: SortState;
}

/** Dense spreadsheet-style layout with configurable stat columns. */
export function LibraryTableView({
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
  columns,
  sort,
}: LibraryTableViewProps) {
  const HeaderLabel = ({ field, label, className = "" }: { field: SortState["field"]; label: string; className?: string }) => (
    <th className={`py-2 ${className}`}>
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-600">
        {label}
        {sort.field === field && (sort.dir === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </span>
    </th>
  );

  return (
    <table className="w-full table-fixed border-separate border-spacing-0">
      <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-black [&_th]:shadow-[inset_0_-1px_0_#222]">
        <tr className="text-left text-[10px] uppercase tracking-wider text-neutral-600">
          <th className="w-16 py-2" />
          <HeaderLabel field="title" label="Track" className="pl-4 pr-3" />
          {columns.artist && <HeaderLabel field="artist" label="Artist" className="pr-3" />}
          {columns.album && <HeaderLabel field="album" label="Album" className="pr-3" />}
          {columns.duration && <HeaderLabel field="duration" label="Length" className="w-16 pr-3" />}
          {columns.bitrate && <HeaderLabel field="bitrate" label="Bitrate" className="w-20 pr-3" />}
          {columns.fileType && <HeaderLabel field="fileType" label="Type" className="w-16 pr-3" />}
          {columns.added && <HeaderLabel field="added" label="Added" className="w-24 pr-3" />}
          {columns.plays && <HeaderLabel field="plays" label="Plays" className="w-16 pr-3" />}
          {columns.lastPlayed && <HeaderLabel field="lastPlayed" label="Last Played" className="w-24 pr-3" />}
          {columns.tags && (
            <th className="py-2 pr-3">
              <span className="text-[10px] uppercase tracking-wider text-neutral-600">Tags</span>
            </th>
          )}
          <th className="w-28 py-2" />
        </tr>
      </thead>
      <tbody className="[&_td]:border-b [&_td]:border-[#111]">
        {tracks.map((track) => {
          const isActive = currentTrackId === track.path;
          const isSelected = selectedPaths.has(track.path);
          return (
            <tr
              key={track.path}
              onClick={(e) => onRowClick(track.path, e)}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
              onDragStart={(e) => e.preventDefault()}
              className={`group cursor-default select-none text-xs hover:bg-[#111] ${
                isSelected
                  ? "bg-violet-600/10 ring-1 ring-inset ring-violet-500/20"
                  : isActive ? "bg-[#111]" : ""
              }`}
            >
              <td className="py-2 pl-6 pr-2">
                <div className="relative h-10 w-10">
                  {track.cover_art_base64 ? (
                    <img
                      src={`data:image/jpeg;base64,${track.cover_art_base64}`}
                      alt=""
                      className="h-10 w-10 rounded object-cover transition-opacity group-hover:opacity-50"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded bg-[#1a1a1a] transition-opacity group-hover:opacity-50">
                      <Music size={14} className="text-neutral-700" />
                    </div>
                  )}
                  <button
                    onClick={() => onPlay(track)}
                    className="absolute inset-0 flex items-center justify-center rounded text-white opacity-0 transition-opacity hover:bg-black/30 group-hover:opacity-100"
                    title="Play"
                  >
                    <Play size={16} fill="currentColor" />
                  </button>
                </div>
              </td>
              <td className="py-2 pl-4 pr-3">
                <div className="min-w-0 tracking-wide">
                  <div className={`truncate ${isActive ? "text-violet-400" : "text-white"}`}>
                    {track.title}
                  </div>
                  <div className="truncate text-[11px] text-neutral-500">
                    {track.artist || "—"}
                  </div>
                </div>
              </td>
              {columns.artist && (
                <td className="truncate py-2 pr-3 text-neutral-400">{track.artist || "—"}</td>
              )}
              {columns.album && (
                <td className="truncate py-2 pr-3 text-neutral-500">{track.album || "—"}</td>
              )}
              {columns.duration && (
                <td className="whitespace-nowrap py-2 pr-3 text-neutral-500">
                  {formatDuration(track.duration_secs)}
                </td>
              )}
              {columns.bitrate && (
                <td
                  className="whitespace-nowrap py-2 pr-3 text-neutral-500"
                  title={
                    track.bitrate_kbps > 0 && track.bitrate_estimated
                      ? "Estimated from file size and duration; not read from audio headers"
                      : undefined
                  }
                >
                  {track.bitrate_kbps > 0
                    ? `${track.bitrate_kbps} kbps${track.bitrate_estimated ? " ?" : ""}`
                    : "—"}
                </td>
              )}
              {columns.fileType && (
                <td className="whitespace-nowrap py-2 pr-3">
                  {track.file_type ? (
                    <span
                      className={typeMismatch(track) ? "text-amber-400" : "text-neutral-500"}
                      title={
                        typeMismatch(track)
                          ? `Actually ${track.file_type} but named .${track.filename.split(".").pop()} — "Fix mislabeled extensions" will rename it`
                          : undefined
                      }
                    >
                      {track.file_type}
                      {typeMismatch(track) ? " ⚠" : ""}
                    </span>
                  ) : (
                    <span className="text-neutral-600">—</span>
                  )}
                </td>
              )}
              {columns.added && (
                <td
                  className="whitespace-nowrap py-2 pr-3 text-neutral-500"
                  title={absoluteDate(track.first_scanned_at)}
                >
                  {relativeTime(track.first_scanned_at)}
                </td>
              )}
              {columns.plays && (
                <td className="whitespace-nowrap py-2 pr-3 text-neutral-500">
                  {track.play_count > 0 ? track.play_count : "—"}
                </td>
              )}
              {columns.lastPlayed && (
                <td
                  className="whitespace-nowrap py-2 pr-3 text-neutral-500"
                  title={absoluteDate(track.last_played_at)}
                >
                  {track.last_played_at > 0 ? relativeTime(track.last_played_at) : "—"}
                </td>
              )}
              {columns.tags && (
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap gap-1">
                    {track.tags.slice(0, 3).map((tag) => (
                      <button
                        key={tag}
                        onClick={() => onTagClick(tag)}
                        className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
                          tagFilter === tag
                            ? "bg-violet-600/20 text-violet-300 ring-1 ring-violet-500/40"
                            : "bg-[#1a1a1a] text-neutral-500 hover:bg-violet-600/10 hover:text-violet-300"
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </td>
              )}
              <td className="py-2 pr-3">
                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
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
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

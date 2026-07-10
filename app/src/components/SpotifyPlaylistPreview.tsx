import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, Music, Hash, Search, CheckCircle, AlertTriangle, XCircle, Loader,
  Download, CheckSquare, Square, ChevronDown, ChevronUp,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen } from "@tauri-apps/api/event";
import type {
  SpotifyPlaylist, SpotifyTrack,
  TidalMatch, TidalMatchProgress, TidalMatchStatus, TidalUser,
} from "../lib/types";
import {
  tidalAuthStatus, tidalMatchTracks, tidalCancelMatch, tidalDownloadMatched, formatErr,
} from "../lib/commands";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";

interface Props {
  playlist: SpotifyPlaylist;
  onClose: () => void;
}

// Playlists at or below this size auto-kick the match on open; larger ones
// require an explicit click so we never silently commit the user to a
// multi-minute (and multi-hundred-request) match they didn't ask for.
const AUTO_MATCH_LIMIT = 200;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function StatusBadge({ status }: { status: TidalMatchStatus | "pending" | undefined }) {
  if (!status) return null;
  switch (status) {
    case "pending":
      return (
        <span className="flex items-center gap-1 rounded bg-neutral-500/10 px-1.5 py-0.5 text-[10px] text-neutral-400">
          <Loader size={10} className="animate-spin" />
          matching
        </span>
      );
    case "found_isrc":
      return (
        <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
          <CheckCircle size={10} />
          ISRC
        </span>
      );
    case "found_fuzzy":
      return (
        <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
          <AlertTriangle size={10} />
          fuzzy
        </span>
      );
    case "not_found":
      return (
        <span className="flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
          <XCircle size={10} />
          not found
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
          <XCircle size={10} />
          error
        </span>
      );
  }
}

interface TrackRowProps {
  track: SpotifyTrack;
  index: number;
  match: TidalMatch | undefined;
  matching: boolean;
  isSelectable: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: (id: string) => void;
  onToggleExpand: (id: string) => void;
}

function TrackRow({
  track: t, index: i, match: m, matching,
  isSelectable, isSelected, isExpanded, onToggleSelect, onToggleExpand,
}: TrackRowProps) {
  return (
    <>
      <div className="flex items-center gap-3 px-5 py-2.5">
        {/* Select checkbox — only enabled when there's a match. */}
        {isSelectable ? (
          <button
            onClick={() => onToggleSelect(t.id)}
            className="shrink-0 text-neutral-400 hover:text-white"
          >
            {isSelected
              ? <CheckSquare size={14} className="text-white" />
              : <Square size={14} />}
          </button>
        ) : (
          <div className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="w-6 shrink-0 text-right text-xs text-neutral-600">{i + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-white">{t.name}</div>
          <div className="truncate text-xs text-neutral-500">
            {t.artists.join(", ")}
            {t.album ? ` · ${t.album}` : ""}
          </div>
        </div>
        {m ? (
          <>
            <StatusBadge status={m.status} />
            {m.tidal_quality && (
              <span
                className="shrink-0 rounded bg-neutral-500/10 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                title="Tidal quality tier"
              >
                {m.tidal_quality}
              </span>
            )}
            {(m.status === "found_fuzzy" || m.status === "found_isrc") && (
              <button
                onClick={() => onToggleExpand(t.id)}
                className="shrink-0 rounded p-1 text-neutral-500 hover:text-white"
                title="Show Tidal match details"
              >
                {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
          </>
        ) : matching ? (
          <StatusBadge status="pending" />
        ) : t.isrc ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded bg-emerald-500/5 px-1.5 py-0.5 font-mono text-[10px] text-emerald-500/70"
            title="Has ISRC — exact Tidal match likely"
          >
            <Hash size={10} />
            {t.isrc}
          </span>
        ) : (
          <span
            className="shrink-0 rounded bg-amber-500/5 px-1.5 py-0.5 text-[10px] text-amber-500/70"
            title="No ISRC — will fall back to fuzzy match"
          >
            no ISRC
          </span>
        )}
        <span className="w-10 shrink-0 text-right text-xs text-neutral-500">
          {formatDuration(t.duration_ms)}
        </span>
      </div>
      {/* Compare view — Tidal's version side-by-side with the
          Spotify source, useful for eyeballing fuzzy matches. */}
      {isExpanded && m && (m.status === "found_isrc" || m.status === "found_fuzzy") && (
        <div className="bg-[#0a0a0a] px-5 pb-3 pt-1 text-xs">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span className="text-neutral-500">Spotify:</span>
            <span className="text-neutral-300">
              {t.name} — {t.artists.join(", ")}
            </span>
            <span className="text-neutral-500">Tidal:</span>
            <span className="text-neutral-300">
              {m.tidal_title} — {m.tidal_artists?.join(", ") ?? ""}
            </span>
            {m.tidal_url && (
              <>
                <span className="text-neutral-500">URL:</span>
                <a
                  href={m.tidal_url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-mono text-neutral-400 underline"
                >
                  {m.tidal_url}
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function SpotifyPlaylistPreview({ playlist, onClose }: Props) {
  const withIsrc = playlist.tracks.filter((t) => t.isrc).length;
  const isSingleTrack = playlist.tracks.length === 1;
  const isLarge = playlist.tracks.length > AUTO_MATCH_LIMIT;
  const [tidalUser, setTidalUser] = useState<TidalUser | null>(null);
  const [matching, setMatching] = useState(false);
  const [matches, setMatches] = useState<Map<string, TidalMatch>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [autoMatched, setAutoMatched] = useState(false);

  const addDownload = useDownloadStore((s) => s.addDownload);
  const destination = useSettingsStore((s) => s.settings.lastDestination);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: playlist.tracks.length,
    getScrollElement: () => scrollRef.current,
    // Two-line row ≈ 57px; expanded rows self-measure via measureElement.
    estimateSize: () => 57,
    overscan: 8,
  });

  useEffect(() => {
    tidalAuthStatus().then(setTidalUser).catch(() => {});
  }, []);

  // Cancel any in-flight backend match when the modal unmounts, so closing it
  // mid-match stops the sequential Tidal loop instead of letting it run on.
  useEffect(() => {
    return () => { tidalCancelMatch().catch(() => {}); };
  }, []);

  // Batch per-track progress events. At playlist scale the backend fires one
  // event per track; applying each with its own setState re-renders on every
  // event. Buffer into refs and flush once per animation frame so a burst of
  // events coalesces into a single render.
  const pendingRef = useRef<Map<string, TidalMatch>>(new Map());
  const progressRef = useRef<{ done: number; total: number } | null>(null);
  const flushScheduled = useRef(false);

  useEffect(() => {
    if (!matching) return;
    const flush = () => {
      flushScheduled.current = false;
      if (pendingRef.current.size > 0) {
        const batch = pendingRef.current;
        pendingRef.current = new Map();
        setMatches((prev) => {
          const next = new Map(prev);
          for (const [k, v] of batch) next.set(k, v);
          return next;
        });
      }
      if (progressRef.current) setProgress(progressRef.current);
    };
    const unlisten = listen<TidalMatchProgress>("tidal-match-progress", (e) => {
      const { index, total, match } = e.payload;
      progressRef.current = { done: index + 1, total };
      pendingRef.current.set(match.spotify_id, match);
      if (!flushScheduled.current) {
        flushScheduled.current = true;
        requestAnimationFrame(flush);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
      flush(); // drain the last buffered batch when matching ends
    };
  }, [matching]);

  // After matching completes, auto-select every track that got a match
  // (ISRC or fuzzy). Fuzzy is included by default per user direction — they
  // can inspect via the expand arrow and untick any that look wrong.
  useEffect(() => {
    if (matching) return;
    if (matches.size === 0) return;
    const auto = new Set<string>();
    for (const m of matches.values()) {
      if (m.status === "found_isrc" || m.status === "found_fuzzy") {
        auto.add(m.spotify_id);
      }
    }
    setSelected(auto);
  }, [matching, matches]);

  const runMatch = async () => {
    setMatching(true);
    setError(null);
    setMatches(new Map());
    setSelected(new Set());
    setProgress({ done: 0, total: playlist.tracks.length });
    try {
      const inputs = playlist.tracks.map((t: SpotifyTrack) => ({
        spotify_id: t.id,
        name: t.name,
        artists: t.artists,
        isrc: t.isrc,
        duration_ms: t.duration_ms,
      }));
      const results = await tidalMatchTracks(inputs);
      const map = new Map<string, TidalMatch>();
      for (const r of results) map.set(r.spotify_id, r);
      setMatches(map);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setMatching(false);
    }
  };

  // Auto-kick the match the first time this preview opens with a logged-in
  // Tidal account — the explicit button felt unnecessary for every playlist.
  // Large playlists are excluded (see AUTO_MATCH_LIMIT) and matched on click.
  useEffect(() => {
    if (autoMatched) return;
    if (!tidalUser) return;
    if (isLarge) return;
    setAutoMatched(true);
    runMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tidalUser]);

  const toggleSelect = useCallback((spotifyId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(spotifyId)) next.delete(spotifyId);
      else next.add(spotifyId);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((spotifyId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(spotifyId)) next.delete(spotifyId);
      else next.add(spotifyId);
      return next;
    });
  }, []);

  const counts = useMemo(() => {
    let isrc = 0, fuzzy = 0, missing = 0, err = 0;
    for (const m of matches.values()) {
      if (m.status === "found_isrc") isrc++;
      else if (m.status === "found_fuzzy") fuzzy++;
      else if (m.status === "not_found") missing++;
      else if (m.status === "error") err++;
    }
    return { isrc, fuzzy, missing, err, matched: isrc + fuzzy };
  }, [matches]);

  const hasRun = matches.size > 0 || matching;

  const selectableMatched = useMemo(() => {
    const out: TidalMatch[] = [];
    for (const m of matches.values()) {
      if ((m.status === "found_isrc" || m.status === "found_fuzzy") && m.tidal_url) {
        out.push(m);
      }
    }
    return out;
  }, [matches]);

  const allSelectable = selectableMatched.length;
  const allSelected = allSelectable > 0 && selected.size === allSelectable;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectableMatched.map((m) => m.spotify_id)));
    }
  };

  const handleClose = () => {
    tidalCancelMatch().catch(() => {});
    onClose();
  };

  const startDownload = async () => {
    const trackById = new Map(playlist.tracks.map((t) => [t.id, t]));
    const jobs = [...selected]
      .map((spotifyId) => {
        const m = matches.get(spotifyId);
        const t = trackById.get(spotifyId);
        if (!m?.tidal_url || !t) return null;
        return {
          id: crypto.randomUUID(),
          tidal_url: m.tidal_url,
          title: `${t.artists.join(", ")} - ${t.name}`,
          displayTitle: t.name,
          displayArtist: t.artists.join(", "),
        };
      })
      .filter((j): j is NonNullable<typeof j> => j !== null);

    if (jobs.length === 0) return;
    setDownloading(true);
    try {
      // Only tag the DownloadQueue with a playlist group when this really
      // is a multi-track playlist. Singles get the regular solo-item row.
      const groupTitle = isSingleTrack ? undefined : playlist.name;
      for (const j of jobs) {
        addDownload({
          id: j.id,
          url: j.tidal_url,
          format: "flac",
          status: "pending",
          progress: 0,
          message: "Queued for Tidal download",
          backend: "tidal-dl-ng",
          title: j.displayTitle,
          artist: j.displayArtist,
          playlistTitle: groupTitle,
        });
      }
      await tidalDownloadMatched(
        jobs.map((j) => ({ id: j.id, tidal_url: j.tidal_url, title: j.title })),
        destination,
        groupTitle,
      );
      onClose();
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setDownloading(false);
    }
  };

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-[#222] bg-[#111]">
        <div className="flex items-center justify-between border-b border-[#222] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{playlist.name}</h2>
            <p className="mt-0.5 truncate text-xs text-neutral-400">
              {playlist.owner ? `${playlist.owner}` : ""}
              {!isSingleTrack && (
                <>
                  {playlist.owner ? " · " : ""}
                  {playlist.tracks.length} tracks · {withIsrc} with ISRC
                </>
              )}
            </p>
          </div>
          <button onClick={handleClose} className="rounded p-1 text-neutral-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* Match controls */}
        <div className="flex items-center justify-between gap-3 border-b border-[#222] px-5 py-3">
          <div className="min-w-0 text-xs text-neutral-400">
            {!tidalUser ? (
              <span className="text-amber-400">Connect Tidal in Settings to match tracks.</span>
            ) : hasRun ? (
              <span>
                <span className="text-emerald-400">{counts.isrc} ISRC</span>
                {" · "}
                <span className="text-amber-400">{counts.fuzzy} fuzzy</span>
                {" · "}
                <span className="text-red-400">{counts.missing} missing</span>
                {counts.err > 0 && (
                  <> · <span className="text-red-400">{counts.err} errors</span></>
                )}
                {matching && progress && (
                  <> — matching {progress.done}/{progress.total}...</>
                )}
              </span>
            ) : isLarge ? (
              <span className="text-amber-400">
                Large playlist ({playlist.tracks.length} tracks) — matching runs one at a
                time and may take several minutes. Click Match to start.
              </span>
            ) : (
              <span>Find these tracks on Tidal, ISRC-first with fuzzy fallback.</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!matching && counts.matched > 0 && !isSingleTrack && (
              <button
                onClick={toggleAll}
                className="flex items-center gap-1.5 rounded-lg border border-[#333] px-2.5 py-1.5 text-xs text-neutral-400 hover:border-[#555] hover:text-white"
              >
                {allSelected ? <CheckSquare size={12} /> : <Square size={12} />}
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            )}
            {/* Initial match button — the primary entry point for large
                playlists (which don't auto-match) and a manual trigger for
                small ones before the auto-match effect fires. */}
            {tidalUser && !hasRun && (
              <button
                onClick={runMatch}
                className="flex items-center gap-2 rounded-lg border border-[#333] px-3 py-1.5 text-xs text-neutral-400 transition-all hover:border-[#555] hover:text-white"
              >
                <Search size={12} />
                Match {playlist.tracks.length > 1 ? `${playlist.tracks.length} tracks` : ""}
              </button>
            )}
            {/* Re-match stays available — auto-match runs once on open but
                the user may still want to retry after fixing their network. */}
            {hasRun && !matching && (
              <button
                onClick={runMatch}
                disabled={!tidalUser}
                className="flex items-center gap-2 rounded-lg border border-[#333] px-3 py-1.5 text-xs text-neutral-400 transition-all hover:border-[#555] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Search size={12} />
                Re-match
              </button>
            )}
          </div>
        </div>

        {/* Track list — virtualized so a thousand-row playlist mounts ~15 rows. */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div
            className="relative w-full"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {virtualItems.map((vi) => {
              const t = playlist.tracks[vi.index];
              const m = matches.get(t.id);
              const isSelectable = m?.status === "found_isrc" || m?.status === "found_fuzzy";
              return (
                <div
                  key={t.id}
                  data-index={vi.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-[#1a1a1a]"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <TrackRow
                    track={t}
                    index={vi.index}
                    match={m}
                    matching={matching}
                    isSelectable={isSelectable}
                    isSelected={selected.has(t.id)}
                    isExpanded={expanded.has(t.id)}
                    onToggleSelect={toggleSelect}
                    onToggleExpand={toggleExpand}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-[#222] px-5 py-3">
          {error ? (
            <div className="flex items-center gap-2 text-xs text-red-300">
              <XCircle size={12} />
              {error}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Music size={12} />
              {hasRun && !matching
                ? `${selected.size} selected of ${counts.matched} matched`
                : "Downloads route through tidal-dl-ng."}
            </div>
          )}
          <button
            onClick={startDownload}
            disabled={selected.size === 0 || downloading}
            className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition-all hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {downloading ? <Loader size={12} className="animate-spin" /> : <Download size={12} />}
            Download {selected.size > 0 ? selected.size : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

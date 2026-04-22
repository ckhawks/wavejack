import { useEffect, useState } from "react";
import { X, Music, Hash, Search, CheckCircle, AlertTriangle, XCircle, Loader } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type {
  SpotifyPlaylist, SpotifyTrack,
  TidalMatch, TidalMatchProgress, TidalMatchStatus, TidalUser,
} from "../lib/types";
import { tidalAuthStatus, tidalMatchTracks, formatErr } from "../lib/commands";

interface Props {
  playlist: SpotifyPlaylist;
  onClose: () => void;
}

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

export function SpotifyPlaylistPreview({ playlist, onClose }: Props) {
  const withIsrc = playlist.tracks.filter((t) => t.isrc).length;
  const [tidalUser, setTidalUser] = useState<TidalUser | null>(null);
  const [matching, setMatching] = useState(false);
  const [matches, setMatches] = useState<Map<string, TidalMatch>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tidalAuthStatus().then(setTidalUser).catch(() => {});
  }, []);

  useEffect(() => {
    if (!matching) return;
    const unlisten = listen<TidalMatchProgress>("tidal-match-progress", (e) => {
      const { index, total, match } = e.payload;
      setProgress({ done: index + 1, total });
      setMatches((prev) => {
        const next = new Map(prev);
        next.set(match.spotify_id, match);
        return next;
      });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [matching]);

  const runMatch = async () => {
    setMatching(true);
    setError(null);
    setMatches(new Map());
    setProgress({ done: 0, total: playlist.tracks.length });
    try {
      const inputs = playlist.tracks.map((t: SpotifyTrack) => ({
        spotify_id: t.id,
        name: t.name,
        artists: t.artists,
        isrc: t.isrc,
        duration_ms: t.duration_ms,
      }));
      console.log("[tidal-match] sending inputs:", inputs);
      console.log(
        "[tidal-match] ISRC summary:",
        inputs.map((i) => ({ name: i.name, isrc: i.isrc }))
      );
      const results = await tidalMatchTracks(inputs);
      console.log("[tidal-match] results:", results);
      const map = new Map<string, TidalMatch>();
      for (const r of results) map.set(r.spotify_id, r);
      setMatches(map);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setMatching(false);
    }
  };

  // Counts for the footer summary.
  const counts = (() => {
    let isrc = 0, fuzzy = 0, missing = 0, err = 0;
    for (const m of matches.values()) {
      if (m.status === "found_isrc") isrc++;
      else if (m.status === "found_fuzzy") fuzzy++;
      else if (m.status === "not_found") missing++;
      else if (m.status === "error") err++;
    }
    return { isrc, fuzzy, missing, err, matched: isrc + fuzzy };
  })();

  const hasRun = matches.size > 0 || matching;

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

        {/* Match controls */}
        <div className="flex items-center justify-between gap-3 border-b border-[#222] px-5 py-3">
          <div className="text-xs text-neutral-400">
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
            ) : (
              <span>Find these tracks on Tidal, ISRC-first with fuzzy fallback.</span>
            )}
          </div>
          <button
            onClick={runMatch}
            disabled={!tidalUser || matching}
            className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition-all hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {matching ? <Loader size={12} className="animate-spin" /> : <Search size={12} />}
            {matching ? "Matching..." : hasRun ? "Re-match" : "Match on Tidal"}
          </button>
        </div>

        {/* Track list */}
        <div className="flex-1 overflow-y-auto">
          {playlist.tracks.map((t, i) => {
            const m = matches.get(t.id);
            return (
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
            );
          })}
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
                ? `${counts.matched} of ${playlist.tracks.length} matched — download wiring lands in the next step.`
                : "Tidal download via tidal-dl-ng coming in the next step."}
            </div>
          )}
          <button
            disabled
            className="cursor-not-allowed rounded-lg border border-[#333] px-3 py-1.5 text-xs text-neutral-600"
            title="Download coming in step 3"
          >
            Download {counts.matched > 0 ? counts.matched : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

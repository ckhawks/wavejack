import { useEffect, useMemo, useState } from "react";
import {
  X, Download, CheckSquare, Square, Waves, Loader, AlertTriangle, CheckCircle,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import {
  startDownload, tidalMatchSoundcloud, tidalDownloadMatched, tidalAuthStatus, formatErr,
} from "../lib/commands";
import type {
  PlaylistInfo, PlaylistEntry, ScTidalMatch, ScTidalMatchProgress, TidalUser,
} from "../lib/types";

interface Props {
  playlist: PlaylistInfo;
  format: "mp4" | "mp3";
  onClose: () => void;
}

/** Delta beyond which a Tidal fuzzy match is worth flagging to the user. */
const DURATION_WARN_SEC = 5;

function isSoundCloudUrl(url: string): boolean {
  return /soundcloud\.com|snd\.sc/i.test(url);
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function PlaylistPreview({ playlist, format, onClose }: Props) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(playlist.entries.map((_, i) => i))
  );
  const [downloading, setDownloading] = useState(false);
  const addDownload = useDownloadStore((s) => s.addDownload);
  const destination = useSettingsStore((s) => s.settings.lastDestination);

  // --- Tidal upgrade (SoundCloud playlists only) -------------------------
  const isSoundCloud = isSoundCloudUrl(playlist.playlist_url);
  const [tidalUser, setTidalUser] = useState<TidalUser | null>(null);
  const [matching, setMatching] = useState(false);
  const [matches, setMatches] = useState<Map<number, ScTidalMatch>>(new Map());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [preferTidal, setPreferTidal] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSoundCloud) return;
    tidalAuthStatus().then(setTidalUser).catch(() => {});
  }, [isSoundCloud]);

  useEffect(() => {
    if (!matching) return;
    const unlisten = listen<ScTidalMatchProgress>("tidal-sc-match-progress", (e) => {
      const { index, total, match } = e.payload;
      setProgress({ done: index + 1, total });
      setMatches((prev) => new Map(prev).set(match.index, match));
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [matching]);

  // After matching finishes, default to taking every matched track from Tidal
  // (higher quality). The user reviews and unticks any that look wrong.
  useEffect(() => {
    if (matching || matches.size === 0) return;
    const auto = new Set<number>();
    for (const m of matches.values()) {
      if (m.status === "found_fuzzy" && m.tidal_url) auto.add(m.index);
    }
    setPreferTidal(auto);
  }, [matching, matches]);

  // Single DRM track (a monetized SoundCloud link the user pasted): the SC
  // original can't be downloaded, so auto-run the Tidal match once — that's the
  // only way to get it, no reason to make them click.
  useEffect(() => {
    if (!tidalUser || matching || matches.size > 0) return;
    if (playlist.entries.length === 1 && playlist.entries[0].drm) {
      runMatch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tidalUser]);

  const runMatch = async () => {
    setMatching(true);
    setError(null);
    setMatches(new Map());
    setPreferTidal(new Set());
    setProgress({ done: 0, total: playlist.entries.length });
    try {
      const inputs = playlist.entries.map((e, i) => ({
        index: i,
        title: e.title,
        uploader: e.uploader,
        duration: e.duration,
      }));
      const results = await tidalMatchSoundcloud(inputs);
      setMatches(new Map(results.map((r) => [r.index, r])));
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setMatching(false);
    }
  };

  const counts = useMemo(() => {
    let found = 0, missing = 0, err = 0;
    for (const m of matches.values()) {
      if (m.status === "found_fuzzy") found++;
      else if (m.status === "error") err++;
      else missing++;
    }
    return { found, missing, err };
  }, [matches]);

  const hasMatched = matches.size > 0 || matching;
  const allSelected = selected.size === playlist.entries.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(playlist.entries.map((_, i) => i)));
  }

  function toggleEntry(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }

  function toggleTidal(index: number) {
    setPreferTidal((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }

  async function handleDownload() {
    setDownloading(true);

    // Split the selected rows by chosen source: Tidal-preferred rows with a
    // real match go through tidal-dl-ng; everything else takes the original
    // SoundCloud audio via yt-dlp.
    const tidalJobs: { id: string; entry: PlaylistEntry; match: ScTidalMatch }[] = [];
    const scEntries: PlaylistEntry[] = [];
    playlist.entries.forEach((entry, i) => {
      if (!selected.has(i)) return;
      const m = matches.get(i);
      if (preferTidal.has(i) && m?.tidal_url) {
        tidalJobs.push({ id: crypto.randomUUID(), entry, match: m });
      } else {
        scEntries.push(entry);
      }
    });

    // Tidal batch first — the command returns immediately and streams progress.
    if (tidalJobs.length > 0) {
      for (const j of tidalJobs) {
        addDownload({
          id: j.id,
          url: j.match.tidal_url!,
          format: "flac",
          status: "pending",
          progress: 0,
          message: "Queued for Tidal download",
          backend: "tidal-dl-ng",
          title: j.match.tidal_title ?? j.entry.title,
          artist: j.match.tidal_artists?.join(", ") ?? j.entry.uploader ?? undefined,
          playlistTitle: playlist.title,
        });
      }
      try {
        await tidalDownloadMatched(
          tidalJobs.map((j) => ({
            id: j.id,
            tidal_url: j.match.tidal_url!,
            title: `${j.match.tidal_artists?.join(", ") ?? ""} - ${j.match.tidal_title ?? j.entry.title}`,
          })),
          destination,
          playlist.title,
        );
      } catch (e) {
        console.error("Failed to start Tidal downloads:", e);
      }
    }

    // Remaining tracks straight from SoundCloud via the existing yt-dlp path.
    for (const entry of scEntries) {
      const id = crypto.randomUUID();
      addDownload({
        id,
        url: entry.url,
        format,
        status: "pending",
        progress: 0,
        message: "Starting...",
        backend: "",
        title: entry.title,
        playlistTitle: playlist.title,
      });
      try {
        await startDownload(id, entry.url, format, playlist.title, destination);
      } catch (e) {
        console.error("Failed to start download:", e);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    onClose();
  }

  const tidalCount = useMemo(
    () => [...selected].filter((i) => preferTidal.has(i) && matches.get(i)?.tidal_url).length,
    [selected, preferTidal, matches]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-[#222] bg-[#111]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#222] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-white">{playlist.title}</h2>
            <p className="mt-0.5 text-xs text-neutral-400">
              {playlist.entries.length} track{playlist.entries.length !== 1 ? "s" : ""}
              {playlist.uploader ? ` · ${playlist.uploader}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between gap-3 border-b border-[#222] px-5 py-2">
          <button
            onClick={toggleAll}
            className="flex items-center gap-2 text-xs text-neutral-400 hover:text-white"
          >
            {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
            {allSelected ? "Deselect All" : "Select All"}
          </button>
          <div className="flex items-center gap-3">
            {/* SoundCloud → Tidal upgrade. Only shown when logged in to Tidal. */}
            {isSoundCloud && tidalUser && (
              <button
                onClick={runMatch}
                disabled={matching}
                className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                title="Search Tidal for each track and upgrade matches to lossless"
              >
                {matching ? <Loader size={12} className="animate-spin" /> : <Waves size={12} />}
                {hasMatched ? "Re-match Tidal" : "Upgrade via Tidal"}
              </button>
            )}
            <span className="text-xs text-neutral-500">{selected.size} selected</span>
          </div>
        </div>

        {/* Match status line */}
        {isSoundCloud && hasMatched && (
          <div className="border-b border-[#222] px-5 py-2 text-xs text-neutral-400">
            <span className="text-cyan-300">{counts.found} on Tidal</span>
            {" · "}
            <span className="text-neutral-500">{counts.missing} SoundCloud-only</span>
            {counts.err > 0 && <> · <span className="text-red-400">{counts.err} errors</span></>}
            {matching && progress && <> — matching {progress.done}/{progress.total}…</>}
          </div>
        )}
        {isSoundCloud && !tidalUser && (
          <div className="border-b border-[#222] px-5 py-2 text-xs text-amber-400/80">
            Connect Tidal in Settings to upgrade matching tracks to lossless.
          </div>
        )}

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto">
          {playlist.entries.map((entry, i) => {
            const m = matches.get(i);
            const onTidal = preferTidal.has(i) && !!m?.tidal_url;
            const delta = m?.duration_delta_sec ?? null;
            const confPct = m?.confidence != null ? Math.round(m.confidence * 100) : null;
            const isSelected = selected.has(i);
            return (
              <div key={i} className="flex items-start gap-3 border-b border-[#1a1a1a] px-5 py-2.5">
                <button
                  onClick={() => toggleEntry(i)}
                  className="mt-0.5 shrink-0 text-neutral-400 hover:text-white"
                >
                  {isSelected
                    ? <CheckSquare size={14} className="text-white" />
                    : <Square size={14} className="text-neutral-600" />}
                </button>
                <span className="mt-0.5 w-6 shrink-0 text-right text-xs text-neutral-600">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  {/* SoundCloud source — full title, wraps instead of truncating */}
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-orange-400/70">SC</span>
                    <span className="break-words text-sm text-white">{entry.title}</span>
                    {entry.drm && (
                      <span
                        className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400"
                        title="Monetized track — SoundCloud serves it DRM-encrypted, so the original can't be downloaded. Use the Tidal match instead."
                      >
                        DRM
                      </span>
                    )}
                  </div>
                  <div className="break-words pl-6 text-xs text-neutral-500">
                    {entry.uploader ?? ""}
                    {entry.duration != null ? `${entry.uploader ? " · " : ""}${formatDuration(entry.duration)}` : ""}
                  </div>

                  {/* Tidal candidate — always visible when matched, so the user
                      can compare the full titles before choosing a source. */}
                  {matching && !m && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-neutral-600">
                      <Loader size={11} className="animate-spin" /> searching Tidal…
                    </div>
                  )}
                  {m?.tidal_url ? (
                    <div
                      className={`mt-1.5 rounded-md border px-2.5 py-1.5 ${
                        onTidal ? "border-cyan-500/40 bg-cyan-500/[0.06]" : "border-[#2a2a2a] bg-[#0d0d0d]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-cyan-400/70">Tidal</span>
                            <span className="break-words text-sm text-cyan-100">
                              {m.tidal_title} — {m.tidal_artists?.join(", ") ?? ""}
                            </span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-6 text-[10px]">
                            {m.tidal_quality && (
                              <span className="rounded bg-neutral-500/10 px-1.5 py-0.5 font-mono text-neutral-400">
                                {m.tidal_quality}
                              </span>
                            )}
                            {confPct != null && (
                              <span
                                className={`rounded px-1.5 py-0.5 ${
                                  confPct >= 85
                                    ? "bg-emerald-500/10 text-emerald-400"
                                    : confPct >= 72
                                      ? "bg-cyan-500/10 text-cyan-300"
                                      : "bg-amber-500/10 text-amber-400"
                                }`}
                              >
                                {confPct}% match
                              </span>
                            )}
                            {delta != null && (
                              <span
                                className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${
                                  delta > DURATION_WARN_SEC
                                    ? "bg-amber-500/10 text-amber-400"
                                    : "bg-neutral-500/10 text-neutral-500"
                                }`}
                                title="Length difference vs. the SoundCloud track"
                              >
                                {delta > DURATION_WARN_SEC && <AlertTriangle size={9} />}
                                {delta === 0 ? "same length" : `${delta}s off`}
                              </span>
                            )}
                            <a
                              href={m.tidal_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-neutral-500 underline hover:text-neutral-300"
                            >
                              open
                            </a>
                          </div>
                        </div>
                        <button
                          onClick={() => toggleTidal(i)}
                          className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors ${
                            onTidal
                              ? "bg-cyan-500/20 text-cyan-200"
                              : "border border-[#333] text-neutral-400 hover:border-cyan-500/40 hover:text-cyan-200"
                          }`}
                          title={onTidal ? "This track will download from Tidal — click to keep SoundCloud" : "Download this track from Tidal instead"}
                        >
                          {onTidal ? <CheckCircle size={11} /> : <Waves size={11} />}
                          {onTidal ? "Using Tidal" : "Use Tidal"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    !matching && hasMatched && isSoundCloud && (
                      <div className={`mt-1 flex items-center gap-1.5 pl-6 text-xs ${entry.drm ? "text-amber-400" : "text-neutral-600"}`}>
                        {entry.drm && <AlertTriangle size={11} className="shrink-0" />}
                        {entry.drm
                          ? "DRM-protected on SoundCloud and no Tidal match — this track can't be downloaded"
                          : "No confident Tidal match — keeping SoundCloud"}
                      </div>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="border-t border-[#222] px-5 py-3">
          {error && (
            <div className="mb-2 flex items-center gap-2 text-xs text-red-300">
              <AlertTriangle size={12} />
              {error}
            </div>
          )}
          <button
            onClick={handleDownload}
            disabled={selected.size === 0 || downloading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {downloading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
            {downloading
              ? "Starting downloads..."
              : tidalCount > 0
                ? `Download ${selected.size} (${tidalCount} via Tidal)`
                : `Download ${selected.size} Track${selected.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

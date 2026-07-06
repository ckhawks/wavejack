import { useEffect, useState } from "react";
import { X, Loader, Music, AlertTriangle, CheckCircle, XCircle, Download } from "lucide-react";
import { tidalAuthStatus, tidalMatchTracks, tidalDownloadMatched, formatErr } from "../lib/commands";
import { useDownloadStore } from "../stores/downloadStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { FeedItem, TidalMatch, TidalUser } from "../lib/types";

interface Props {
  item: FeedItem;
  onUseYoutube: () => void;
  onDownloaded: () => void;
  onClose: () => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "no_auth" }
  | { kind: "result"; match: TidalMatch }
  | { kind: "error"; message: string };

export function FeedDownloadDialog({ item, onUseYoutube, onDownloaded, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [submitting, setSubmitting] = useState(false);

  const addDownload = useDownloadStore((s) => s.addDownload);
  const destination = useSettingsStore((s) => s.settings.lastDestination);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let user: TidalUser | null = null;
      try {
        user = await tidalAuthStatus();
      } catch {
        user = null;
      }
      if (cancelled) return;
      if (!user) {
        setPhase({ kind: "no_auth" });
        return;
      }
      try {
        const [match] = await tidalMatchTracks([
          {
            spotify_id: item.video_id,
            name: item.title,
            artists: [item.uploader],
            isrc: null,
            duration_ms: item.duration * 1000,
          },
        ]);
        if (cancelled) return;
        setPhase({ kind: "result", match });
      } catch (e) {
        if (cancelled) return;
        setPhase({ kind: "error", message: formatErr(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [item]);

  const handleTidal = (match: TidalMatch) => {
    if (!match.tidal_url) return;
    const id = crypto.randomUUID();
    const title = match.tidal_title ?? item.title;
    const artist = match.tidal_artists?.join(", ") ?? item.uploader;
    addDownload({
      id,
      url: match.tidal_url,
      format: "flac",
      status: "pending",
      progress: 0,
      message: "Starting Tidal download...",
      backend: "tidal-dl-ng",
      title,
      artist,
    });
    setSubmitting(true);
    tidalDownloadMatched(
      [{ id, tidal_url: match.tidal_url, title: `${artist} - ${title}` }],
      destination,
    ).catch((e) => console.error("Tidal download failed:", e));
    onDownloaded();
  };

  const handleYoutube = () => {
    setSubmitting(true);
    onUseYoutube();
    onDownloaded();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="flex w-full max-w-lg flex-col rounded-xl border border-[#222] bg-[#111]">
        <div className="flex items-center justify-between border-b border-[#222] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">Find on Tidal</h2>
            <p className="mt-0.5 truncate text-xs text-neutral-400">{item.title}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-5">
          {phase.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-neutral-400">
              <Loader size={14} className="animate-spin" />
              Looking up on Tidal...
            </div>
          )}

          {phase.kind === "no_auth" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-sm text-neutral-300">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
                <span>You're not signed in to Tidal. Sign in from Settings to download lossless versions.</span>
              </div>
            </div>
          )}

          {phase.kind === "error" && (
            <div className="flex items-start gap-2 text-sm text-neutral-300">
              <XCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <span>Tidal lookup failed: {phase.message}</span>
            </div>
          )}

          {phase.kind === "result" && phase.match.status === "not_found" && (
            <div className="flex items-start gap-2 text-sm text-neutral-300">
              <XCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <span>No confident Tidal match for this track.</span>
            </div>
          )}

          {phase.kind === "result" && phase.match.status === "error" && (
            <div className="flex items-start gap-2 text-sm text-neutral-300">
              <XCircle size={16} className="mt-0.5 shrink-0 text-red-400" />
              <span>Tidal match error: {phase.match.reason ?? "unknown"}</span>
            </div>
          )}

          {phase.kind === "result"
            && (phase.match.status === "found_isrc" || phase.match.status === "found_fuzzy")
            && phase.match.tidal_url && (
            <div className="space-y-3">
              <div className="rounded-lg border border-[#222] bg-[#0a0a0a] p-3">
                <div className="flex items-start gap-2">
                  <Music size={16} className="mt-0.5 shrink-0 text-violet-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{phase.match.tidal_title}</p>
                    <p className="truncate text-xs text-neutral-400">{phase.match.tidal_artists?.join(", ")}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      {phase.match.status === "found_isrc" ? (
                        <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
                          <CheckCircle size={10} /> ISRC match
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
                          <AlertTriangle size={10} /> fuzzy match
                        </span>
                      )}
                      {phase.match.tidal_quality && (
                        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">
                          {phase.match.tidal_quality}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#222] px-5 py-3">
          <button
            onClick={handleYoutube}
            disabled={submitting}
            className="rounded-md border border-[#333] bg-[#111] px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:border-[#555] hover:text-white disabled:opacity-40"
          >
            Use YouTube instead
          </button>
          {phase.kind === "result"
            && (phase.match.status === "found_isrc" || phase.match.status === "found_fuzzy")
            && phase.match.tidal_url && (
            <button
              onClick={() => handleTidal(phase.match)}
              disabled={submitting}
              className="flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-neutral-200 disabled:opacity-40"
            >
              <Download size={12} />
              Download from Tidal
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

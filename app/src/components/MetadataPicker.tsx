import { useState, useEffect } from "react";
import { Loader, Music } from "lucide-react";
import { fetchMetadata } from "../lib/commands";
import type { MetadataMatch, AppliedMetadata } from "../lib/types";

interface Props {
  currentTitle?: string;
  currentArtist?: string;
  /** Called with the chosen MusicBrainz match. Should write tags + return the result. */
  onApply: (match: MetadataMatch) => Promise<AppliedMetadata>;
  /** Notified after onApply resolves so the caller can update its own store. */
  onApplied?: (result: AppliedMetadata) => void;
  onClose: () => void;
}

export function MetadataPicker({ currentTitle, currentArtist, onApply, onApplied, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [matches, setMatches] = useState<MetadataMatch[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const query = [currentTitle, currentArtist].filter(Boolean).join(" ") || "unknown";
    setLoading(true);
    setError("");
    fetchMetadata(query)
      .then((results) => setMatches(results))
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [currentTitle, currentArtist]);

  async function handleApply(match: MetadataMatch) {
    setApplying(true);
    try {
      const result = await onApply(match);
      onApplied?.(result);
      onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setApplying(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 border-t border-[#222] pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-400">MusicBrainz Results</span>
        <button
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-white"
        >
          Close
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-2 text-xs text-neutral-500">
          <Loader size={12} className="animate-spin" />
          Searching MusicBrainz...
        </div>
      )}

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      {!loading && !error && matches.length === 0 && (
        <p className="text-xs text-neutral-500">No matches found</p>
      )}

      {!loading && matches.map((m, i) => (
        <button
          key={i}
          onClick={() => handleApply(m)}
          disabled={applying}
          className="flex w-full items-center gap-3 rounded-md border border-[#222] bg-[#0a0a0a] p-2 text-left transition-all hover:border-[#444] disabled:opacity-50"
        >
          <Music size={14} className="shrink-0 text-neutral-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-white">{m.title}</p>
            <p className="truncate text-xs text-neutral-400">
              {m.artist}{m.album ? ` · ${m.album}` : ""}
            </p>
          </div>
          <span className="shrink-0 text-xs text-neutral-600">{m.score}%</span>
        </button>
      ))}
    </div>
  );
}

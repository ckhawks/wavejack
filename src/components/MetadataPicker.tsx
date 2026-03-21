import { useState, useEffect } from "react";
import { Loader, Music } from "lucide-react";
import { fetchMetadata, applyMetadata } from "../lib/commands";
import { useDownloadStore } from "../stores/downloadStore";
import type { MetadataMatch } from "../lib/types";

interface Props {
  id: string;
  filePath: string;
  currentTitle?: string;
  currentArtist?: string;
  onClose: () => void;
}

export function MetadataPicker({ id, filePath, currentTitle, currentArtist, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [matches, setMatches] = useState<MetadataMatch[]>([]);
  const [error, setError] = useState("");
  const updateDownload = useDownloadStore((s) => s.updateDownload);

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
      const result = await applyMetadata(
        id,
        filePath,
        match.title,
        match.artist,
        match.album,
        match.release_mbid
      );
      updateDownload(id, {
        title: result.title,
        artist: result.artist,
        album: result.album,
        coverArtBase64: result.cover_art_base64 || undefined,
        filePath: result.new_file_path,
      });
      onClose();
    } catch (e: any) {
      setError(String(e?.message || e));
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

import { useState } from "react";
import { Plus, X, Sparkles, Loader } from "lucide-react";
import { useDiscoverStore } from "../../stores/discoverStore";
import { useDownloadStore } from "../../stores/downloadStore";
import type { SeedTrack } from "../../lib/types";

export function SeedPicker() {
  const seeds = useDiscoverStore((s) => s.seeds);
  const addSeed = useDiscoverStore((s) => s.addSeed);
  const removeSeed = useDiscoverStore((s) => s.removeSeed);
  const fetchRecommendations = useDiscoverStore((s) => s.fetchRecommendations);
  const isLoading = useDiscoverStore((s) => s.isLoading);
  const error = useDiscoverStore((s) => s.error);

  const downloads = useDownloadStore((s) => s.downloads);
  const [search, setSearch] = useState("");

  // Filter completed MP3s that have artist + title metadata
  const candidates = downloads.filter(
    (d) =>
      d.status === "complete" &&
      d.format === "mp3" &&
      d.title &&
      d.artist &&
      (search === "" ||
        d.title.toLowerCase().includes(search.toLowerCase()) ||
        d.artist.toLowerCase().includes(search.toLowerCase()))
  );

  function handleAdd(track: { title: string; artist: string }) {
    const seed: SeedTrack = { title: track.title, artist: track.artist };
    addSeed(seed);
  }

  const isSeedSelected = (title: string, artist: string) =>
    seeds.some(
      (s) =>
        s.title.toLowerCase() === title.toLowerCase() &&
        s.artist.toLowerCase() === artist.toLowerCase()
    );

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-hidden">
      <div>
        <h2 className="text-lg font-semibold text-white">Discover</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Pick 1-5 seed tracks, then find similar music via Last.fm.
        </p>
      </div>

      {/* Selected seeds */}
      {seeds.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {seeds.map((seed, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 rounded-full bg-[#222] px-3 py-1.5 text-xs font-medium text-white"
            >
              {seed.artist} - {seed.title}
              <button
                onClick={() => removeSeed(i)}
                className="rounded-full p-0.5 text-neutral-500 hover:text-white"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Go button */}
      <div className="flex items-center gap-3">
        <button
          onClick={fetchRecommendations}
          disabled={seeds.length === 0 || isLoading}
          className="flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-black transition-all duration-200 hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? (
            <>
              <Loader size={14} className="animate-spin" />
              Finding similar tracks...
            </>
          ) : (
            <>
              <Sparkles size={14} />
              Find Similar ({seeds.length}/5 seeds)
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {/* Search + track list */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search your downloads..."
        className="rounded-lg border border-[#333] bg-[#111] px-4 py-2.5 text-sm text-white placeholder-neutral-600 outline-none transition-all duration-200 focus:border-[#555]"
      />

      <div className="flex-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="py-8 text-center text-sm text-neutral-600">
            {search
              ? "No matches found."
              : "No completed MP3s with metadata found. Download some tracks first!"}
          </p>
        ) : (
          <div className="space-y-1">
            {candidates.map((d) => {
              const selected = isSeedSelected(d.title!, d.artist!);
              return (
                <div
                  key={d.id}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-[#111]"
                >
                  {d.coverArtBase64 && (
                    <img
                      src={`data:image/jpeg;base64,${d.coverArtBase64}`}
                      alt=""
                      className="h-8 w-8 shrink-0 rounded object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{d.title}</p>
                    <p className="truncate text-xs text-neutral-500">{d.artist}</p>
                  </div>
                  <button
                    onClick={() => handleAdd({ title: d.title!, artist: d.artist! })}
                    disabled={selected || seeds.length >= 5}
                    className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-[#222] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                    title={selected ? "Already added" : "Add as seed"}
                  >
                    <Plus size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

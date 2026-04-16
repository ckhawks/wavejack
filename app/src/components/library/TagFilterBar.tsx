import { useState, useRef, useEffect } from "react";
import { X, Tag, Loader } from "lucide-react";
import { useLibraryStore } from "../../stores/libraryStore";

export function TagFilterBar() {
  const allTags = useLibraryStore((s) => s.allTags);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const setTagFilter = useLibraryStore((s) => s.setTagFilter);
  const tagFetchProgress = useLibraryStore((s) => s.tagFetchProgress);
  const startBulkFetchTags = useLibraryStore((s) => s.startBulkFetchTags);

  const [showDropdown, setShowDropdown] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filteredTags = search.trim()
    ? allTags.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()))
    : allTags;

  const isFetching = tagFetchProgress !== null;

  return (
    <div className="flex items-center gap-2 px-6">
      <Tag size={12} className="shrink-0 text-neutral-600" />

      {/* Active tag filter chip */}
      {tagFilter && (
        <button
          onClick={() => setTagFilter(null)}
          className="flex items-center gap-1 rounded-full bg-violet-600/20 px-2.5 py-0.5 text-[11px] font-medium text-violet-300 ring-1 ring-violet-500/40 transition-colors hover:bg-violet-600/30"
        >
          {tagFilter}
          <X size={10} />
        </button>
      )}

      {/* Tag picker dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => { setShowDropdown((v) => !v); setSearch(""); }}
          className="rounded bg-[#111] px-2 py-1 text-[10px] text-neutral-500 ring-1 ring-[#333] transition-colors hover:text-neutral-300 hover:ring-[#555]"
        >
          {tagFilter ? "Change tag" : "Filter by tag"}
        </button>

        {showDropdown && (
          <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-[#333] bg-[#0a0a0a] shadow-xl">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tags..."
              className="w-full border-b border-[#222] bg-transparent px-3 py-2 text-xs text-white placeholder-neutral-600 outline-none"
              autoFocus
            />
            <div className="max-h-48 overflow-y-auto">
              {filteredTags.length === 0 ? (
                <p className="px-3 py-2 text-xs text-neutral-600">
                  {allTags.length === 0 ? "No tags yet — click Fetch Tags" : "No matches"}
                </p>
              ) : (
                filteredTags.slice(0, 30).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setTagFilter(t.name); setShowDropdown(false); }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition-colors hover:bg-[#1a1a1a] ${
                      tagFilter === t.name ? "text-violet-400" : "text-neutral-300"
                    }`}
                  >
                    <span className="truncate">{t.name}</span>
                    <span className="shrink-0 text-[10px] text-neutral-600">{t.track_count}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Fetch Tags button */}
      <button
        onClick={startBulkFetchTags}
        disabled={isFetching}
        className="ml-auto flex items-center gap-1.5 rounded bg-[#222] px-3 py-1 text-[10px] text-neutral-400 hover:bg-[#333] hover:text-white disabled:opacity-40"
        title="Fetch genre tags from Last.fm for all tracks"
      >
        {isFetching ? (
          <>
            <Loader size={10} className="animate-spin" />
            {tagFetchProgress.done}/{tagFetchProgress.total}
          </>
        ) : (
          <>
            <Tag size={10} />
            Fetch Tags
          </>
        )}
      </button>
    </div>
  );
}

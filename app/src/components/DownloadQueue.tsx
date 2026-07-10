import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, ListMusic } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDownloadStore } from "../stores/downloadStore";
import { DownloadItem } from "./DownloadItem";
import type { DownloadItem as DLItem } from "../lib/types";

interface PlaylistGroup {
  title: string;
  items: DLItem[];
}

// Groups larger than this start collapsed and render virtualized when opened,
// so a thousand-track playlist import doesn't mount a thousand animated rows.
const GROUP_VIRTUALIZE_THRESHOLD = 60;

/** Virtualized item list for large groups: a bounded-height scroll region that
 *  mounts only the visible rows. Rows self-measure (DownloadItem grows when its
 *  edit form or metadata picker opens), so heights stay accurate. */
function VirtualizedItems({ items }: { items: DLItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 6,
  });
  return (
    <div ref={scrollRef} className="max-h-[60vh] overflow-y-auto pr-1">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={items[vi.index].id}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full pb-2"
            style={{ transform: `translateY(${vi.start}px)` }}
          >
            <DownloadItem item={items[vi.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CollapsibleGroup({ group }: { group: PlaylistGroup }) {
  const large = group.items.length > GROUP_VIRTUALIZE_THRESHOLD;
  // Large groups start collapsed — opening a thousand-row list is opt-in.
  const [collapsed, setCollapsed] = useState(large);
  const completed = group.items.filter((d) => d.status === "complete").length;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[#111]"
      >
        {collapsed ? (
          <ChevronRight size={14} className="text-neutral-500" />
        ) : (
          <ChevronDown size={14} className="text-neutral-500" />
        )}
        <ListMusic size={14} className="text-indigo-400" />
        <span className="text-sm font-medium text-neutral-300">{group.title}</span>
        <span className="text-xs text-neutral-600">
          {completed}/{group.items.length} complete
        </span>
      </button>
      {!collapsed &&
        (large ? (
          <VirtualizedItems items={group.items} />
        ) : (
          <AnimatePresence>
            {group.items.map((item) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <DownloadItem item={item} />
              </motion.div>
            ))}
          </AnimatePresence>
        ))}
    </div>
  );
}

export function DownloadQueue() {
  const downloads = useDownloadStore((s) => s.downloads);
  const clearCompleted = useDownloadStore((s) => s.clearCompleted);

  const hasCompleted = downloads.some(
    (d) => d.status === "complete" || d.status === "error" || d.status === "file_missing"
  );

  // Walk downloads in insertion (chronological) order, but render each
  // playlist group as one entry at the position of its first item so
  // singles and groups interleave by when they were added.
  type QueueEntry =
    | { kind: "solo"; item: DLItem }
    | { kind: "group"; group: PlaylistGroup };

  const entries: QueueEntry[] = (() => {
    const byTitle = new Map<string, DLItem[]>();
    for (const d of downloads) {
      if (!d.playlistTitle) continue;
      const arr = byTitle.get(d.playlistTitle) || [];
      arr.push(d);
      byTitle.set(d.playlistTitle, arr);
    }

    const seen = new Set<string>();
    const out: QueueEntry[] = [];
    for (const d of downloads) {
      if (!d.playlistTitle) {
        out.push({ kind: "solo", item: d });
        continue;
      }
      if (seen.has(d.playlistTitle)) continue;
      seen.add(d.playlistTitle);
      out.push({ kind: "group", group: { title: d.playlistTitle, items: byTitle.get(d.playlistTitle)! } });
    }
    return out;
  })();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Queue header */}
      {downloads.length > 0 && (
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm text-neutral-400">
            {downloads.length} download{downloads.length !== 1 ? "s" : ""}
          </span>
          {hasCompleted && (
            <button
              onClick={clearCompleted}
              className="text-sm text-neutral-500 transition-colors hover:text-white"
            >
              Clear completed
            </button>
          )}
        </div>
      )}

      {downloads.length > 0 ? (
        <div className="flex-1 space-y-2 overflow-y-auto">
          <AnimatePresence>
            {entries.map((entry) =>
              entry.kind === "solo" ? (
                <motion.div
                  key={entry.item.id}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                >
                  <DownloadItem item={entry.item} />
                </motion.div>
              ) : (
                <CollapsibleGroup key={entry.group.title} group={entry.group} />
              )
            )}
          </AnimatePresence>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-neutral-600">
            Paste a URL above to start downloading
          </p>
        </div>
      )}
    </div>
  );
}

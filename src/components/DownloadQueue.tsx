import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, ListMusic } from "lucide-react";
import { useDownloadStore } from "../stores/downloadStore";
import { DownloadItem } from "./DownloadItem";
import type { DownloadItem as DLItem } from "../lib/types";

interface PlaylistGroup {
  title: string;
  items: DLItem[];
}

function CollapsibleGroup({ group }: { group: PlaylistGroup }) {
  const [collapsed, setCollapsed] = useState(false);
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
      {!collapsed && (
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
      )}
    </div>
  );
}

export function DownloadQueue() {
  const downloads = useDownloadStore((s) => s.downloads);
  const clearCompleted = useDownloadStore((s) => s.clearCompleted);

  const hasCompleted = downloads.some(
    (d) => d.status === "complete" || d.status === "error" || d.status === "file_missing"
  );

  // Group items by playlist
  const { groups, ungrouped } = (() => {
    const groupMap = new Map<string, DLItem[]>();
    const solo: DLItem[] = [];

    for (const d of downloads) {
      if (d.playlistTitle) {
        const arr = groupMap.get(d.playlistTitle) || [];
        arr.push(d);
        groupMap.set(d.playlistTitle, arr);
      } else {
        solo.push(d);
      }
    }

    const groups: PlaylistGroup[] = [];
    for (const [title, items] of groupMap) {
      groups.push({ title, items });
    }

    return { groups, ungrouped: solo };
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
          {/* Ungrouped items */}
          <AnimatePresence>
            {ungrouped.map((item) => (
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

          {/* Playlist groups */}
          {groups.map((group) => (
            <CollapsibleGroup key={group.title} group={group} />
          ))}
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

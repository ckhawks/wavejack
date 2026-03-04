import { AnimatePresence, motion } from "framer-motion";
import { useDownloadStore } from "../stores/downloadStore";
import { DownloadItem } from "./DownloadItem";

export function DownloadQueue() {
  const downloads = useDownloadStore((s) => s.downloads);
  const clearCompleted = useDownloadStore((s) => s.clearCompleted);

  const hasCompleted = downloads.some(
    (d) => d.status === "complete" || d.status === "error"
  );

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

      {/* Download list with animations */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        <AnimatePresence>
          {downloads.map((item) => (
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
      </div>

      {/* Empty state */}
      {downloads.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-neutral-600">
            Paste a URL above to start downloading
          </p>
        </div>
      )}
    </div>
  );
}

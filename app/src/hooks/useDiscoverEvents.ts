import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDiscoverStore } from "../stores/discoverStore";
import type { DownloadStatusEvent, DiscoverItem } from "../lib/types";

/**
 * Listens to both "download-status" and "discover-status" events
 * and patches discover queue items whose IDs match.
 */
export function useDiscoverEvents() {
  const updateItem = useDiscoverStore((s) => s.updateItem);

  useEffect(() => {
    function handleEvent(payload: DownloadStatusEvent) {
      const { id, status, progress, message, file_path, cover_art_base64 } = payload;

      // Check if this ID belongs to the discover queue
      const queue = useDiscoverStore.getState().queue;
      const item = queue.find((q) => q.id === id);
      if (!item) return;

      const patch: Partial<DiscoverItem> = {
        progress,
        message,
      };

      if (status === "complete") {
        patch.status = "ready";
        patch.message = "Ready to play";
      } else if (status === "error") {
        patch.status = "error";
      } else if (status === "downloading" || status === "converting") {
        patch.status = "downloading";
      }

      if (file_path) patch.filePath = file_path;
      if (cover_art_base64) patch.coverArtBase64 = cover_art_base64;

      updateItem(id, patch);

      // Auto-play if this is the current track and it just became ready
      if (patch.status === "ready") {
        const { currentIndex, queue: q, playCurrent } = useDiscoverStore.getState();
        if (q[currentIndex]?.id === id) {
          playCurrent();
        }
      }
    }

    const unlisten1 = listen<DownloadStatusEvent>("download-status", (e) =>
      handleEvent(e.payload)
    );
    const unlisten2 = listen<DownloadStatusEvent>("discover-status", (e) =>
      handleEvent(e.payload)
    );

    return () => {
      unlisten1.then((fn) => fn());
      unlisten2.then((fn) => fn());
    };
  }, [updateItem]);
}

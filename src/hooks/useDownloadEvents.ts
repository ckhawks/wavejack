import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDownloadStore } from "../stores/downloadStore";
import type { DownloadItem, DownloadStatusEvent } from "../lib/types";

/**
 * Hook that listens to Tauri "download-status" events from the Rust backend
 * and patches the download store accordingly.
 * Should be called once at the app root level.
 */
export function useDownloadEvents() {
  const updateDownload = useDownloadStore((s) => s.updateDownload);

  useEffect(() => {
    const unlisten = listen<DownloadStatusEvent>(
      "download-status",
      (event) => {
        const { id, status, progress, message, backend, title, file_path, cover_art_base64 } =
          event.payload;

        // Infer artist/title from filename if it contains " - "
        let inferredTitle = title;
        let inferredArtist: string | undefined;
        if (title && title.includes(" - ")) {
          const dashIndex = title.indexOf(" - ");
          inferredArtist = title.substring(0, dashIndex).trim();
          inferredTitle = title.substring(dashIndex + 3).trim();
        }

        updateDownload(id, {
          status: status as DownloadItem["status"],
          progress,
          message,
          backend: backend as DownloadItem["backend"],
          ...(inferredTitle ? { title: inferredTitle } : {}),
          ...(inferredArtist ? { artist: inferredArtist } : {}),
          ...(file_path ? { filePath: file_path } : {}),
          ...(cover_art_base64 ? { coverArtBase64: cover_art_base64 } : {}),
        });
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateDownload]);
}

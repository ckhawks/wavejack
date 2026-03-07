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
        const { id, status, progress, message, backend, title, file_path } =
          event.payload;
        updateDownload(id, {
          status: status as DownloadItem["status"],
          progress,
          message,
          backend: backend as DownloadItem["backend"],
          ...(title ? { title } : {}),
          ...(file_path ? { filePath: file_path } : {}),
        });
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateDownload]);
}

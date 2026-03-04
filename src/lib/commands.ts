import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "./types";

/** Start downloading a URL with the given format */
export async function startDownload(
  id: string,
  url: string,
  format: string
): Promise<void> {
  return invoke("start_download", { id, url, format });
}

/** Ensure yt-dlp is ready (downloads if needed). Returns the binary path. */
export async function ensureYtdlpReady(): Promise<string> {
  return invoke("ensure_ytdlp_ready");
}

/** Get current app settings */
export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

/** Update a single setting */
export async function setSetting(
  key: string,
  value: string
): Promise<void> {
  return invoke("set_setting", { key, value });
}

/** Open a file with the system default application */
export async function openFile(path: string): Promise<void> {
  return invoke("open_file", { path });
}

/** Reveal a file in the system file explorer */
export async function revealFile(path: string): Promise<void> {
  return invoke("reveal_file", { path });
}

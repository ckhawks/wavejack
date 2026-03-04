/** Represents a single download in the queue */
export interface DownloadItem {
  id: string;
  url: string;
  format: "mp4" | "mp3";
  status: "pending" | "downloading" | "converting" | "complete" | "error";
  progress: number;
  message: string;
  backend: "ytdlp" | "cobalt" | "none" | "";
  title?: string;
  filePath?: string;
}

/** App settings persisted via Tauri plugin-store */
export interface AppSettings {
  outputDir: string;
  cobaltUrl: string;
  format: "mp4" | "mp3";
}

/** Shape of the download-status event from Rust */
export interface DownloadStatusEvent {
  id: string;
  status: string;
  progress: number;
  message: string;
  backend: string;
  title?: string;
  file_path?: string;
}

/** Shape of the ytdlp-download-progress event from Rust */
export interface YtdlpProgressEvent {
  stage: "downloading" | "complete";
  progress: number;
}

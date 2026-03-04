// downloader.rs — The orchestrator module.
// This module ties together yt-dlp and cobalt into a single download flow:
//   1. Try yt-dlp first (it's the most reliable for YouTube/SoundCloud)
//   2. If yt-dlp fails and the user has a cobalt instance configured, try cobalt
//   3. If both fail, report the combined error
// All progress events are unified under the "download-status" event name.

use crate::cobalt::download_with_cobalt;
use crate::error::AppError;
use crate::ytdlp::{download_with_ytdlp, ensure_ytdlp, DownloadStatusEvent};
use tauri::{AppHandle, Emitter};

/// Main download function — this is what gets called from the Tauri command.
/// It handles the yt-dlp → cobalt fallback logic.
///
/// Arguments:
/// - `app`: Tauri app handle (needed for emitting events and accessing app data)
/// - `download_id`: Unique ID for this download task
/// - `url`: The media URL to download
/// - `format`: "mp4" or "mp3"
/// - `output_dir`: Directory where files should be saved
/// - `cobalt_url`: Optional cobalt instance URL (empty string means not configured)
pub async fn download(
    app: &AppHandle,
    download_id: &str,
    url: &str,
    format: &str,
    output_dir: &str,
    cobalt_url: &str,
) -> Result<(), AppError> {
    // Step 1: Make sure yt-dlp is available (download if needed)
    let ytdlp_result = ensure_ytdlp(app).await;

    // Step 2: Try downloading with yt-dlp
    let ytdlp_error = match ytdlp_result {
        Ok(ytdlp_path) => {
            // We have yt-dlp, try using it
            match download_with_ytdlp(&ytdlp_path, url, format, output_dir, download_id, app).await
            {
                Ok(()) => return Ok(()), // Success! We're done.
                Err(e) => {
                    // yt-dlp failed — log the error and try cobalt
                    let err_msg = e.to_string();
                    eprintln!("yt-dlp failed: {}", err_msg);
                    err_msg
                }
            }
        }
        Err(e) => {
            // Couldn't even get yt-dlp — report why
            let err_msg = e.to_string();
            eprintln!("yt-dlp not available: {}", err_msg);
            err_msg
        }
    };

    // Step 3: Try cobalt as fallback (only if the user configured a cobalt URL)
    if !cobalt_url.is_empty() {
        // Emit an event so the frontend knows we switched to cobalt
        let _ = app.emit(
            "download-status",
            DownloadStatusEvent {
                id: download_id.to_string(),
                status: "downloading".into(),
                progress: 0.0,
                message: "yt-dlp failed, trying Cobalt...".into(),
                backend: "cobalt".into(),
                title: None,
                file_path: None,
            },
        );

        match download_with_cobalt(cobalt_url, url, format, output_dir, download_id, app).await {
            Ok(()) => return Ok(()), // Cobalt succeeded!
            Err(e) => {
                // Both backends failed — report both errors
                let cobalt_err = e.to_string();
                eprintln!("Cobalt also failed: {}", cobalt_err);

                // Emit error event
                let _ = app.emit(
                    "download-status",
                    DownloadStatusEvent {
                        id: download_id.to_string(),
                        status: "error".into(),
                        progress: 0.0,
                        message: format!("All backends failed"),
                        backend: "none".into(),
                        title: None,
                        file_path: None,
                    },
                );

                return Err(AppError::AllBackendsFailed {
                    ytdlp_err: ytdlp_error,
                    cobalt_err,
                });
            }
        }
    }

    // If we get here, yt-dlp failed and cobalt isn't configured
    let _ = app.emit(
        "download-status",
        DownloadStatusEvent {
            id: download_id.to_string(),
            status: "error".into(),
            progress: 0.0,
            message: format!("Download failed: {}", ytdlp_error),
            backend: "none".into(),
            title: None,
            file_path: None,
        },
    );

    Err(AppError::YtDlpFailed(ytdlp_error))
}

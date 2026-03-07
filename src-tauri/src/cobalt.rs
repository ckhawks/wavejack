// cobalt.rs — Fallback download backend using the cobalt.tools API.
// Cobalt is a web service that can download media from various platforms.
// We use it as a fallback when yt-dlp fails.
// NOTE: The public api.cobalt.tools has bot protection, so users need
// to configure their own cobalt instance URL in settings.

use crate::downloader::DownloadResult;
use crate::error::AppError;
use crate::ytdlp::DownloadStatusEvent;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

/// Download a URL using the cobalt.tools API.
///
/// Arguments:
/// - `cobalt_url`: The base URL of the cobalt instance (e.g., "https://my-cobalt.example.com")
/// - `url`: The media URL to download
/// - `format`: "mp4" or "mp3"
/// - `output_dir`: Directory to save the downloaded file
/// - `download_id`: Unique ID for tracking this download
/// - `app`: Tauri app handle for emitting progress events
pub async fn download_with_cobalt(
    cobalt_url: &str,
    url: &str,
    format: &str,
    output_dir: &str,
    download_id: &str,
    app: &AppHandle,
) -> Result<DownloadResult, AppError> {
    // Build the HTTP client
    let client = reqwest::Client::new();

    // Construct the API request body.
    // Cobalt expects a JSON payload describing what to download and in what format.
    let body = serde_json::json!({
        "url": url,
        "audioFormat": if format == "mp3" { "mp3" } else { "best" },
        "audioBitrate": "320",        // Highest quality audio
        "videoQuality": "max",         // Highest quality video
        "filenameStyle": "pretty",     // Use a clean filename
        "downloadMode": if format == "mp3" { "audio" } else { "auto" }
    });

    // Send the POST request to the cobalt API
    let response = client
        .post(cobalt_url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::CobaltFailed(format!("Request failed: {}", e)))?;

    // Check if the API returned an error status
    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(AppError::CobaltFailed(format!(
            "Cobalt returned HTTP {}: {}",
            status, body_text
        )));
    }

    // Parse the JSON response from cobalt.
    // It returns a JSON object with a "url" field containing the direct download link.
    let cobalt_response: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::CobaltFailed(format!("Invalid JSON response: {}", e)))?;

    // Extract the download URL from cobalt's response
    let download_url = cobalt_response
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            // If there's no "url" field, cobalt probably returned an error
            let error_text = cobalt_response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown cobalt error");
            AppError::CobaltFailed(error_text.to_string())
        })?;

    // Now download the actual file from the URL cobalt gave us
    let _ = app.emit(
        "download-status",
        DownloadStatusEvent {
            id: download_id.to_string(),
            status: "downloading".into(),
            progress: 0.0,
            message: "Downloading via Cobalt...".into(),
            backend: "cobalt".into(),
            title: None,
            file_path: None,
        },
    );

    let file_response = reqwest::get(download_url)
        .await
        .map_err(|e| AppError::CobaltFailed(format!("File download failed: {}", e)))?;

    // Try to figure out the filename from Content-Disposition header or fallback to a default
    let filename = extract_filename(&file_response, format);
    let file_path = std::path::PathBuf::from(output_dir).join(&filename);

    // Get total size for progress tracking
    let total_size = file_response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    // Stream the file to disk chunk by chunk
    let mut file = tokio::fs::File::create(&file_path)
        .await
        .map_err(|e| AppError::CobaltFailed(format!("Cannot create file: {}", e)))?;

    let mut stream = file_response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::CobaltFailed(format!("Stream error: {}", e)))?;

        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| AppError::CobaltFailed(format!("Write error: {}", e)))?;

        downloaded += chunk.len() as u64;

        // Calculate and emit progress
        let progress = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };

        let _ = app.emit(
            "download-status",
            DownloadStatusEvent {
                id: download_id.to_string(),
                status: "downloading".into(),
                progress,
                message: format!("Downloading via Cobalt... {}%", progress as u32),
                backend: "cobalt".into(),
                title: None,
                file_path: None,
            },
        );
    }

    let file_path_str = file_path.to_string_lossy().to_string();

    // Emit completion
    let _ = app.emit(
        "download-status",
        DownloadStatusEvent {
            id: download_id.to_string(),
            status: "complete".into(),
            progress: 100.0,
            message: "Download complete!".into(),
            backend: "cobalt".into(),
            title: Some(filename.clone()),
            file_path: Some(file_path_str.clone()),
        },
    );

    Ok(DownloadResult {
        title: Some(filename),
        file_path: Some(file_path_str),
        backend: "cobalt".to_string(),
    })
}

/// Try to extract a filename from the HTTP response headers.
/// Falls back to a default name if the header isn't present.
fn extract_filename(response: &reqwest::Response, format: &str) -> String {
    // Try to get the filename from the Content-Disposition header
    // It looks like: Content-Disposition: attachment; filename="video.mp4"
    if let Some(cd) = response.headers().get("content-disposition") {
        if let Ok(cd_str) = cd.to_str() {
            if let Some(start) = cd_str.find("filename=") {
                let name = cd_str[start + 9..].trim_matches('"').trim_matches('\'');
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }

    // Fallback: generate a default filename
    let ext = if format == "mp3" { "mp3" } else { "mp4" };
    format!("download_{}.{}", uuid::Uuid::new_v4(), ext)
}

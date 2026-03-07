// ytdlp.rs — Everything related to finding, downloading, and running yt-dlp.
// This is the most complex module because it handles:
//   1. Finding an existing yt-dlp binary on the system
//   2. Auto-downloading yt-dlp from GitHub if it's not installed
//   3. Spawning yt-dlp as a child process and parsing its progress output
//   4. Emitting Tauri events so the frontend can show real-time progress

use crate::downloader::DownloadResult;
use crate::error::AppError;
use futures_util::StreamExt;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// The filename of the yt-dlp binary — on Windows it needs .exe
#[cfg(target_os = "windows")]
const YTDLP_BIN: &str = "yt-dlp.exe";

#[cfg(not(target_os = "windows"))]
const YTDLP_BIN: &str = "yt-dlp";

/// Try to find yt-dlp in two places:
/// 1. On the system PATH (e.g., if the user installed it globally)
/// 2. In our app's data directory under a "bin" subfolder
pub fn find_ytdlp() -> Option<PathBuf> {
    // First, check the system PATH using the `which` crate
    if let Ok(path) = which::which("yt-dlp") {
        return Some(path);
    }

    // Second, check our own app data directory
    // dirs::data_dir() returns something like:
    //   Windows: C:\Users\<user>\AppData\Roaming
    //   macOS:   ~/Library/Application Support
    //   Linux:   ~/.local/share
    if let Some(data_dir) = dirs::data_dir() {
        let local_path = data_dir.join("media-downloader").join("bin").join(YTDLP_BIN);
        if local_path.exists() {
            return Some(local_path);
        }
    }

    // Not found anywhere
    None
}

/// Make sure yt-dlp is available. If it's not found, download it from GitHub releases.
/// Emits "ytdlp-download-progress" events so the frontend can show a progress bar.
pub async fn ensure_ytdlp(app: &AppHandle) -> Result<PathBuf, AppError> {
    // If we already have it, just return the path
    if let Some(path) = find_ytdlp() {
        return Ok(path);
    }

    // Determine where to save the downloaded binary
    let data_dir = dirs::data_dir()
        .ok_or_else(|| AppError::Io("Cannot determine app data directory".into()))?;
    let bin_dir = data_dir.join("media-downloader").join("bin");

    // Create the bin directory if it doesn't exist
    tokio::fs::create_dir_all(&bin_dir).await?;

    let dest_path = bin_dir.join(YTDLP_BIN);

    // Build the download URL for the latest yt-dlp release from GitHub.
    // yt-dlp publishes binaries for each platform.
    let download_url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
        YTDLP_BIN
    );

    // Emit an event to tell the frontend we're starting the download
    let _ = app.emit("ytdlp-download-progress", serde_json::json!({
        "stage": "downloading",
        "progress": 0
    }));

    // Use reqwest to stream the download (so we can track progress)
    let response = reqwest::get(&download_url).await?;

    // Get the total file size from the Content-Length header (if provided)
    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    // Open a file to write the binary into
    let mut file = tokio::fs::File::create(&dest_path).await?;
    let mut stream = response.bytes_stream();

    // Read the response body chunk by chunk
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Io(e.to_string()))?;

        // Write this chunk to the file
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;

        // Update our progress counter
        downloaded += chunk.len() as u64;

        // Calculate percentage and emit to frontend
        let progress = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u32
        } else {
            0
        };

        let _ = app.emit("ytdlp-download-progress", serde_json::json!({
            "stage": "downloading",
            "progress": progress
        }));
    }

    // On Unix systems, we need to make the binary executable (chmod +x)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&dest_path).await?.permissions();
        perms.set_mode(0o755); // rwxr-xr-x
        tokio::fs::set_permissions(&dest_path, perms).await?;
    }

    // Tell the frontend we're done
    let _ = app.emit("ytdlp-download-progress", serde_json::json!({
        "stage": "complete",
        "progress": 100
    }));

    Ok(dest_path)
}

/// Payload we emit for each download progress update.
/// The frontend listens for "download-status" events with this shape.
#[derive(Clone, serde::Serialize)]
pub struct DownloadStatusEvent {
    /// Unique ID for this download (matches the frontend's download item)
    pub id: String,
    /// Current status: "downloading", "complete", "error", "converting"
    pub status: String,
    /// Progress percentage (0-100)
    pub progress: f64,
    /// Human-readable status message (e.g., "Downloading 45%", "Converting to mp3...")
    pub message: String,
    /// Which backend is doing the work: "ytdlp" or "cobalt"
    pub backend: String,
    /// The title of the media (extracted from yt-dlp output)
    pub title: Option<String>,
    /// The final file path on disk (set when download completes)
    pub file_path: Option<String>,
}

/// Actually run yt-dlp to download a URL.
/// This spawns yt-dlp as a child process and parses its stdout for progress info.
///
/// Arguments:
/// - `ytdlp_path`: Path to the yt-dlp binary
/// - `url`: The URL to download
/// - `format`: Either "mp4" or "mp3"
/// - `output_dir`: Where to save the downloaded file
/// - `download_id`: Unique ID to tag progress events with
/// - `app`: Tauri app handle for emitting events
pub async fn download_with_ytdlp(
    ytdlp_path: &PathBuf,
    url: &str,
    format: &str,
    output_dir: &str,
    download_id: &str,
    app: &AppHandle,
) -> Result<DownloadResult, AppError> {
    // Build the yt-dlp command with the right arguments for the requested format
    let mut cmd = Command::new(ytdlp_path);

    // Tell yt-dlp to output progress in a machine-readable format.
    // The template produces lines like: "progress:45.2:Downloading video"
    cmd.arg("--progress-template")
        .arg("download:progress:%(progress._percent_str)s:%(progress._speed_str)s")
        .arg("--newline") // Print progress on new lines (not overwriting)
        .arg("--no-colors") // Don't use ANSI color codes
        .arg("-o") // Output filename template
        .arg(format!("{}/%(title)s.%(ext)s", output_dir));

    // Add format-specific arguments
    match format {
        "mp3" => {
            // Extract audio only, convert to mp3 at highest quality
            cmd.arg("-x") // Extract audio
                .arg("--audio-format").arg("mp3")
                .arg("--audio-quality").arg("0"); // 0 = best quality
        }
        _ => {
            // Download best video+audio combo as mp4
            cmd.arg("-f")
                .arg("bv*+ba/b")
                .arg("--merge-output-format")
                .arg("mp4")
                .arg("--remux-video")
                .arg("mp4");
        }
    }

    // Finally, add the URL to download
    cmd.arg(url);

    // Redirect stdout so we can read progress, merge stderr into stdout
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Spawn the process
    let mut child = cmd.spawn().map_err(|e| {
        AppError::YtDlpFailed(format!("Failed to spawn yt-dlp: {}", e))
    })?;

    // Take ownership of stdout so we can read it line by line
    let stdout = child.stdout.take()
        .ok_or_else(|| AppError::YtDlpFailed("Failed to capture yt-dlp stdout".into()))?;

    let stderr = child.stderr.take();

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let id = download_id.to_string();
    let app_clone = app.clone();

    // Read stdout line by line and parse progress
    // Also capture title and file path from yt-dlp's output
    let mut title: Option<String> = None;
    let mut file_path: Option<String> = None;

    while let Some(line) = lines.next_line().await.map_err(|e| {
        AppError::YtDlpFailed(format!("Error reading yt-dlp output: {}", e))
    })? {
        // yt-dlp prints the video title in lines like "[download] Destination: /path/to/Title.mp4"
        if line.contains("[download] Destination:") {
            // Extract the filename and try to get the title from it
            if let Some(dest) = line.split("Destination:").nth(1) {
                let filename = dest.trim();
                // Save the full file path so we can open it later
                file_path = Some(filename.to_string());
                // Get just the filename without path and extension
                if let Some(name) = std::path::Path::new(filename).file_stem() {
                    title = Some(name.to_string_lossy().to_string());
                }
            }
        }

        // Also catch "[Merger] Merging formats into ..." which gives the final path
        if line.contains("[Merger] Merging formats into") {
            if let Some(path) = line.split('"').nth(1) {
                file_path = Some(path.to_string());
            }
        }

        // Catch "[ExtractAudio] Destination: ..." for mp3 conversions
        if line.contains("[ExtractAudio] Destination:") {
            if let Some(dest) = line.split("Destination:").nth(1) {
                file_path = Some(dest.trim().to_string());
            }
        }

        // Also try to extract title from "[info]" or metadata lines
        if line.contains("[download] Downloading item") {
            // This is a playlist — extract the item count
            // Format: "[download] Downloading item X of Y"
            let _ = app_clone.emit("download-status", DownloadStatusEvent {
                id: id.clone(),
                status: "downloading".into(),
                progress: 0.0,
                message: line.trim().to_string(),
                backend: "ytdlp".into(),
                title: title.clone(),
                file_path: None,
            });
            continue;
        }

        // Parse our custom progress template output
        // Format: "progress:  45.2%:  1.5MiB/s"
        if line.starts_with("progress:") || line.contains("progress:") {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 2 {
                // Parse the percentage value, stripping whitespace and %
                let percent_str = parts[1].trim().trim_end_matches('%').trim();
                if let Ok(percent) = percent_str.parse::<f64>() {
                    let speed = if parts.len() >= 3 { parts[2].trim() } else { "" };
                    let _ = app_clone.emit("download-status", DownloadStatusEvent {
                        id: id.clone(),
                        status: "downloading".into(),
                        progress: percent,
                        message: format!("Downloading... {}% {}", percent as u32, speed),
                        backend: "ytdlp".into(),
                        title: title.clone(),
                        file_path: None,
                    });
                }
            }
        }

        // Detect conversion/merging phase
        if line.contains("[Merger]") || line.contains("[ExtractAudio]") || line.contains("[ffmpeg]") {
            let _ = app_clone.emit("download-status", DownloadStatusEvent {
                id: id.clone(),
                status: "converting".into(),
                progress: 99.0,
                message: "Converting...".into(),
                backend: "ytdlp".into(),
                title: title.clone(),
                file_path: None,
            });
        }
    }

    // Wait for the process to finish and check its exit status
    let status = child.wait().await.map_err(|e| {
        AppError::YtDlpFailed(format!("Failed to wait for yt-dlp: {}", e))
    })?;

    if !status.success() {
        // Read stderr for the error message
        let mut error_msg = format!("yt-dlp exited with code: {}", status);
        if let Some(stderr) = stderr {
            let stderr_reader = BufReader::new(stderr);
            let mut stderr_lines = stderr_reader.lines();
            let mut stderr_output = String::new();
            while let Some(line) = stderr_lines.next_line().await.unwrap_or(None) {
                stderr_output.push_str(&line);
                stderr_output.push('\n');
            }
            if !stderr_output.is_empty() {
                error_msg = stderr_output;
            }
        }
        return Err(AppError::YtDlpFailed(error_msg));
    }

    // Emit completion event with the final file path
    let _ = app.emit("download-status", DownloadStatusEvent {
        id: download_id.to_string(),
        status: "complete".into(),
        progress: 100.0,
        message: "Download complete!".into(),
        backend: "ytdlp".into(),
        title: title.clone(),
        file_path: file_path.clone(),
    });

    Ok(DownloadResult {
        title,
        file_path,
        backend: "ytdlp".to_string(),
    })
}

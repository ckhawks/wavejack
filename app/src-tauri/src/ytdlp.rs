// ytdlp.rs — Everything related to finding, downloading, and running yt-dlp.
// This is the most complex module because it handles:
//   1. Finding an existing yt-dlp binary on the system
//   2. Auto-downloading yt-dlp from GitHub if it's not installed
//   3. Spawning yt-dlp as a child process and parsing its progress output
//   4. Emitting Tauri events so the frontend can show real-time progress

use crate::downloader::DownloadResult;
use crate::error::AppError;
use futures_util::StreamExt;
use id3::TagLike;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, BufReader};
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
    /// Base64-encoded cover art (YouTube thumbnail or MusicBrainz art)
    pub cover_art_base64: Option<String>,
}

/// Parse one line of yt-dlp stdout. Updates title/file_path in place and
/// emits progress events on the given AppHandle.
fn process_ytdlp_line(
    line: &str,
    id: &str,
    app: &AppHandle,
    title: &mut Option<String>,
    file_path: &mut Option<String>,
) {
    // "[download] Destination: /path/to/Title.mp4"
    if line.contains("[download] Destination:") {
        if let Some(dest) = line.split("Destination:").nth(1) {
            let filename = dest.trim();
            *file_path = Some(filename.to_string());
            if let Some(name) = std::path::Path::new(filename).file_stem() {
                *title = Some(name.to_string_lossy().to_string());
            }
        }
    }

    // "[download] /path/to/file has already been downloaded"
    if line.contains("has already been downloaded") {
        if let Some(rest) = line.strip_prefix("[download]") {
            let rest = rest.trim();
            if let Some(path_str) = rest.strip_suffix("has already been downloaded") {
                let path_str = path_str.trim();
                if !path_str.is_empty() {
                    *file_path = Some(path_str.to_string());
                    if let Some(name) = std::path::Path::new(path_str).file_stem() {
                        *title = Some(name.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // "[Merger] Merging formats into \"...\""
    if line.contains("[Merger] Merging formats into") {
        if let Some(path) = line.split('"').nth(1) {
            *file_path = Some(path.to_string());
        }
    }

    // "[ExtractAudio] Destination: ..."
    if line.contains("[ExtractAudio] Destination:") {
        if let Some(dest) = line.split("Destination:").nth(1) {
            *file_path = Some(dest.trim().to_string());
        }
    }

    // Playlist item counter
    if line.contains("[download] Downloading item") {
        let _ = app.emit("download-status", DownloadStatusEvent {
            id: id.to_string(),
            status: "downloading".into(),
            progress: 0.0,
            message: line.trim().to_string(),
            backend: "ytdlp".into(),
            title: title.clone(),
            file_path: None,
            cover_art_base64: None,
        });
        return;
    }

    // Progress template: "progress:  45.2%:  1.5MiB/s"
    if line.starts_with("progress:") || line.contains("progress:") {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 2 {
            let percent_str = parts[1].trim().trim_end_matches('%').trim();
            if let Ok(percent) = percent_str.parse::<f64>() {
                let speed = if parts.len() >= 3 { parts[2].trim() } else { "" };
                let _ = app.emit("download-status", DownloadStatusEvent {
                    id: id.to_string(),
                    status: "downloading".into(),
                    progress: percent,
                    message: format!("Downloading... {}% {}", percent as u32, speed),
                    backend: "ytdlp".into(),
                    title: title.clone(),
                    file_path: None,
                    cover_art_base64: None,
                });
            }
        }
    }

    // Conversion/merging phase
    if line.contains("[Merger]") || line.contains("[ExtractAudio]") || line.contains("[ffmpeg]") {
        let _ = app.emit("download-status", DownloadStatusEvent {
            id: id.to_string(),
            status: "converting".into(),
            progress: 99.0,
            message: "Converting...".into(),
            backend: "ytdlp".into(),
            title: title.clone(),
            file_path: None,
            cover_art_base64: None,
        });
    }
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

    // Force UTF-8 output so non-ASCII titles/paths don't produce invalid bytes.
    cmd.env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .arg("--encoding")
        .arg("utf-8");

    // Tell yt-dlp to output progress in a machine-readable format.
    // The template produces lines like: "progress:45.2:Downloading video"
    cmd.arg("--progress-template")
        .arg("download:progress:%(progress._percent_str)s:%(progress._speed_str)s")
        .arg("--newline") // Print progress on new lines (not overwriting)
        .arg("--no-colors") // Don't use ANSI color codes
        .arg("-o") // Output filename template
        .arg(format!("{}/%(title)s.%(ext)s", output_dir));

    // Prevent playlist re-expansion when downloading individual items
    cmd.arg("--no-playlist");

    // Write thumbnail so we can use it as cover art
    cmd.arg("--write-thumbnail")
        .arg("--convert-thumbnails")
        .arg("jpg");

    // Add format-specific arguments
    match format {
        "mp3" => {
            // Extract audio only, convert to mp3 at highest quality
            cmd.arg("-x") // Extract audio
                .arg("--audio-format").arg("mp3")
                .arg("--audio-quality").arg("0"); // 0 = best quality
        }
        _ => {
            // Only select H.264+AAC streams — guarantees Premiere/editor compatibility.
            // YouTube always has H.264; final fallback grabs best and yt-dlp will
            // remux into mp4 container.
            cmd.arg("-f")
                .arg("bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/bv*+ba/b")
                .arg("--merge-output-format")
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

    // Read stdout as raw bytes and split on newlines, lossy-decoding each line.
    // This avoids errors when yt-dlp or a child (ffmpeg) emits bytes that
    // aren't valid UTF-8 — common on Windows with non-ASCII video titles.
    let mut reader = BufReader::new(stdout);
    let mut pending: Vec<u8> = Vec::new();
    let mut read_buf = [0u8; 4096];

    let id = download_id.to_string();
    let app_clone = app.clone();
    let mut title: Option<String> = None;
    let mut file_path: Option<String> = None;

    loop {
        let n = reader.read(&mut read_buf).await.map_err(|e| {
            AppError::YtDlpFailed(format!("Error reading yt-dlp output: {}", e))
        })?;

        if n == 0 {
            // EOF — flush any trailing partial line then stop
            if !pending.is_empty() {
                let line = String::from_utf8_lossy(&pending).to_string();
                pending.clear();
                if !line.is_empty() {
                    process_ytdlp_line(&line, &id, &app_clone, &mut title, &mut file_path);
                }
            }
            break;
        }

        pending.extend_from_slice(&read_buf[..n]);

        while let Some(pos) = pending.iter().position(|&b| b == b'\n' || b == b'\r') {
            let mut line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            line_bytes.pop(); // strip the \n or \r
            if line_bytes.is_empty() {
                continue;
            }
            let line = String::from_utf8_lossy(&line_bytes).to_string();
            process_ytdlp_line(&line, &id, &app_clone, &mut title, &mut file_path);
        }
    }

    // Wait for the process to finish and check its exit status
    let status = child.wait().await.map_err(|e| {
        AppError::YtDlpFailed(format!("Failed to wait for yt-dlp: {}", e))
    })?;

    if !status.success() {
        // Read stderr for the error message
        let mut error_msg = format!("yt-dlp exited with code: {}", status);
        if let Some(mut stderr) = stderr {
            let mut bytes: Vec<u8> = Vec::new();
            let _ = stderr.read_to_end(&mut bytes).await;
            if !bytes.is_empty() {
                error_msg = String::from_utf8_lossy(&bytes).to_string();
            }
        }
        return Err(AppError::YtDlpFailed(error_msg));
    }

    // Try to find and process the YouTube thumbnail
    let mut cover_art_base64: Option<String> = None;
    if let Some(ref fp) = file_path {
        let media_path = std::path::Path::new(fp);
        // yt-dlp saves thumbnails as <name>.jpg next to the media file
        let thumb_path = media_path.with_extension("jpg");
        if thumb_path.exists() {
            if let Ok(thumb_bytes) = tokio::fs::read(&thumb_path).await {
                if !thumb_bytes.is_empty() {
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&thumb_bytes);
                    cover_art_base64 = Some(b64);

                    // Embed thumbnail as cover art in MP3 files
                    if fp.ends_with(".mp3") {
                        let mp3_path = std::path::PathBuf::from(fp);
                        let mut tag = id3::Tag::read_from_path(&mp3_path)
                            .unwrap_or_else(|_| id3::Tag::new());
                        // Only embed if no cover art already present
                        if tag.pictures().next().is_none() {
                            tag.add_frame(id3::frame::Picture {
                                mime_type: "image/jpeg".to_string(),
                                picture_type: id3::frame::PictureType::CoverFront,
                                description: String::new(),
                                data: thumb_bytes,
                            });
                            let _ = tag.write_to_path(&mp3_path, id3::Version::Id3v24);
                        }
                    }
                }
            }
            // Clean up the thumbnail file
            let _ = tokio::fs::remove_file(&thumb_path).await;
        }
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
        cover_art_base64: cover_art_base64.clone(),
    });

    Ok(DownloadResult {
        title,
        file_path,
        backend: "ytdlp".to_string(),
        cover_art_base64,
    })
}

/// A single entry in a playlist.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: String,
    pub duration: Option<f64>,
    pub uploader: Option<String>,
}

/// Playlist metadata extracted via yt-dlp --flat-playlist.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistInfo {
    pub title: String,
    pub uploader: Option<String>,
    pub entries: Vec<PlaylistEntry>,
    pub playlist_url: String,
}

/// Extract playlist entries without downloading.
pub async fn extract_playlist(
    ytdlp_path: &PathBuf,
    url: &str,
) -> Result<PlaylistInfo, AppError> {
    let output = Command::new(ytdlp_path)
        .args(["--flat-playlist", "-J", "--no-warnings", url])
        .output()
        .await
        .map_err(|e| AppError::YtDlpFailed(format!("Failed to spawn yt-dlp: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::YtDlpFailed(format!(
            "yt-dlp playlist extraction failed: {}",
            stderr
        )));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::YtDlpFailed(format!("Invalid JSON from yt-dlp: {}", e)))?;

    let entries_arr = json["entries"]
        .as_array()
        .ok_or_else(|| AppError::YtDlpFailed("Not a playlist (no entries array)".to_string()))?;

    let playlist_title = json["title"].as_str().unwrap_or("Playlist").to_string();
    let uploader = json["uploader"].as_str().map(|s| s.to_string());

    let entries: Vec<PlaylistEntry> = entries_arr
        .iter()
        .filter_map(|entry| {
            let entry_url = entry["url"]
                .as_str()
                .or_else(|| entry["id"].as_str())
                .map(|s| {
                    if s.starts_with("http") {
                        s.to_string()
                    } else {
                        format!("https://www.youtube.com/watch?v={}", s)
                    }
                })?;

            let title = entry["title"]
                .as_str()
                .unwrap_or("Unknown")
                .to_string();

            let duration = entry["duration"].as_f64();
            let uploader = entry["uploader"].as_str().map(|s| s.to_string());

            Some(PlaylistEntry {
                url: entry_url,
                title,
                duration,
                uploader,
            })
        })
        .collect();

    if entries.is_empty() {
        return Err(AppError::YtDlpFailed(
            "Playlist has no entries".to_string(),
        ));
    }

    Ok(PlaylistInfo {
        title: playlist_title,
        uploader,
        entries,
        playlist_url: url.to_string(),
    })
}

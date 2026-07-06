// ytdlp.rs — Everything related to finding, downloading, and running yt-dlp.
// This is the most complex module because it handles:
//   1. Finding an existing yt-dlp binary on the system
//   2. Auto-downloading yt-dlp from GitHub if it's not installed
//   3. Spawning yt-dlp as a child process and parsing its progress output
//   4. Emitting Tauri events so the frontend can show real-time progress

use crate::cover_art;
use crate::downloader::DownloadResult;
use crate::error::AppError;
use futures_util::StreamExt;
use lofty::file::AudioFile;
use lofty::probe::Probe;
use std::path::{Path, PathBuf};
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
/// True for any soundcloud.com / api.soundcloud.com URL. Used to switch
/// on original-download behavior (see `download_with_ytdlp`).
pub fn is_soundcloud_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("soundcloud.com") || lower.contains("snd.sc")
}

/// Lossless containers we re-wrap to FLAC after a SoundCloud "original"
/// download. Excludes `.flac` itself (already where we want to be) and
/// lossy formats (transcoding to FLAC would just waste space).
fn is_lossless_to_flac(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("wav" | "aiff" | "aif")
    )
}

/// Re-encode a WAV/AIFF file to FLAC using ffmpeg. FLAC is lossless,
/// roughly half the size, and supports proper Vorbis-comment metadata
/// (including embedded cover art) — unlike WAV's spotty RIFF/ID3 mix.
/// Returns the path to the new `.flac` file. The caller is responsible
/// for deleting the original.
async fn wav_to_flac(input: &Path) -> Result<PathBuf, AppError> {
    let ffmpeg = which::which("ffmpeg")
        .map_err(|_| AppError::Io("ffmpeg not found on PATH — required for WAV→FLAC conversion.".into()))?;

    let output = input.with_extension("flac");
    if output.exists() {
        return Err(AppError::Io(format!(
            "FLAC already exists at {}",
            output.display()
        )));
    }

    let status = Command::new(&ffmpeg)
        .args(["-loglevel", "error", "-y", "-i"])
        .arg(input)
        .args(["-c:a", "flac", "-compression_level", "8"])
        .arg(&output)
        .status()
        .await
        .map_err(|e| AppError::Io(format!("Failed to spawn ffmpeg: {}", e)))?;

    if !status.success() {
        // Best-effort cleanup of a partial output file before bubbling up.
        let _ = tokio::fs::remove_file(&output).await;
        return Err(AppError::Io(format!(
            "ffmpeg exited with {} converting WAV to FLAC",
            status
        )));
    }

    Ok(output)
}

pub async fn download_with_ytdlp(
    ytdlp_path: &PathBuf,
    url: &str,
    format: &str,
    output_dir: &str,
    download_id: &str,
    app: &AppHandle,
    soundcloud_cookies_browser: Option<&str>,
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

    // SoundCloud: prefer the uploader's original file (the "download"
    // format) over the 128/160 kbps streams. Requires SC-account cookies
    // to actually unlock the original; without cookies this falls back
    // to bestaudio, matching prior behavior. We intentionally skip the
    // mp3 re-encode so lossless originals (WAV/FLAC/AIFF) stay lossless.
    let is_sc = is_soundcloud_url(url);
    if is_sc {
        cmd.arg("-f").arg("download/bestaudio/best");
        if let Some(browser) = soundcloud_cookies_browser {
            if !browser.is_empty() {
                cmd.arg("--cookies-from-browser").arg(browser);
            }
        }
    } else {
        match format {
            "mp3" => {
                // Prefer M4A (AAC) passthrough — YouTube's native audio stream,
                // so no transcode and no generation loss. Rekordbox/Serato/iTunes
                // read m4a natively. Fallback chain skips Opus/WebM (`.webm`
                // isn't supported by most DJ software) by requiring an AAC-ish
                // codec before the final bestaudio catch-all.
                cmd.arg("-f")
                    .arg("bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[ext=mp3]/bestaudio")
                    .arg("--embed-thumbnail")
                    .arg("--embed-metadata");
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

    // SoundCloud's lossless originals come down as .wav (or .aiff). WAV
    // metadata is a mess (RIFF INFO + nonstandard ID3 chunks) and the
    // files are roughly 2× the size of FLAC for identical audio, so
    // transcode lossless WAV/AIFF straight to FLAC. yt-dlp's thumbnail
    // sidecar is renamed alongside the audio so the embed step below
    // still finds it.
    if is_sc {
        if let Some(ref fp) = file_path {
            let src_path = PathBuf::from(fp);
            if is_lossless_to_flac(&src_path) {
                match wav_to_flac(&src_path).await {
                    Ok(flac_path) => {
                        // Move the thumbnail sidecar (if any) to match
                        // the new stem so the existing embed code finds it.
                        let old_thumb = src_path.with_extension("jpg");
                        let new_thumb = flac_path.with_extension("jpg");
                        if old_thumb.exists() && old_thumb != new_thumb {
                            let _ = tokio::fs::rename(&old_thumb, &new_thumb).await;
                        }
                        let _ = tokio::fs::remove_file(&src_path).await;
                        file_path = Some(flac_path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        // Non-fatal: keep the WAV, just warn. The user
                        // still got the lossless audio they wanted.
                        eprintln!("WAV→FLAC conversion failed: {}", e);
                    }
                }
            }
        }
    }

    // Correct the extension if it lies about the content (e.g. yt-dlp/Tidal
    // handed back an AAC/MP4 stream but the filename ended up ".mp3"). Doing
    // this before the cover embed means art is written to the right file.
    if let Some(ref fp) = file_path {
        if let Ok((fixed, true)) = crate::library::fix_extension(std::path::Path::new(fp)) {
            file_path = Some(fixed.to_string_lossy().to_string());
        }
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

                    // Embed thumbnail as cover art via lofty so it works
                    // for mp3, flac, m4a, and wav alike.
                    if let Err(e) = cover_art::write_cover_to_file(media_path, &thumb_bytes) {
                        eprintln!("Failed to embed cover art into {}: {}", fp, e);
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

    // Probe the finalized file for its real format + bitrate so the queue badge
    // reflects ground truth — not the requested intent. The extension is the
    // post-conversion truth (e.g. a SoundCloud WAV re-encoded to FLAC above).
    if let Some(ref fp) = file_path {
        let path = Path::new(fp);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let bitrate = Probe::open(path)
            .ok()
            .and_then(|p| p.read().ok())
            .map(|t| t.properties().audio_bitrate().unwrap_or(0))
            .unwrap_or(0);
        let _ = app.emit("download-enriched", serde_json::json!({
            "id": download_id,
            "audio_format": ext,
            "bitrate_kbps": bitrate,
        }));
    }

    Ok(DownloadResult {
        title,
        file_path,
        backend: "ytdlp".to_string(),
        cover_art_base64,
    })
}

/// Promo/junk fragments that show up bracketed in SoundCloud titles and only
/// hurt a Tidal catalog search. Matched case-insensitively against the *inner*
/// text of a `(...)` or `[...]` group. Remix/mix descriptors are deliberately
/// absent — those identify genuinely distinct tracks on Tidal, so we keep them.
const SC_PROMO_MARKERS: &[&str] = &[
    "free download", "free dl", "free d/l", "buy now", "out now", "click buy",
    "premiere", "exclusive", "supported by", "played by", "hypeddit", "toneden",
    "repost", "teaser", "snippet", "download in description",
];

/// Collapse runs of whitespace to single spaces and trim the ends.
fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Remove bracketed groups that look like promo noise, keeping every other
/// bracket group verbatim. Unbalanced brackets stop the scan and the rest is
/// kept as-is (better to over-keep than mangle a weird title).
fn strip_promo_brackets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open_idx) = rest.find(['(', '[']) {
        let open = rest.as_bytes()[open_idx] as char;
        let close = if open == '(' { ')' } else { ']' };
        let Some(rel_close) = rest[open_idx + 1..].find(close) else {
            break; // unbalanced — bail and keep the remainder
        };
        let close_idx = open_idx + 1 + rel_close;
        let inner = rest[open_idx + 1..close_idx].to_ascii_lowercase();
        let is_promo = SC_PROMO_MARKERS.iter().any(|m| inner.contains(m));
        out.push_str(&rest[..open_idx]);
        if !is_promo {
            out.push_str(&rest[open_idx..=close_idx]);
        }
        rest = &rest[close_idx + 1..];
    }
    out.push_str(rest);
    collapse_ws(&out)
}

/// Split `Artist - Title` on the first spaced dash (ASCII or unicode en/em).
/// Returns `None` when there's no such separator or either side is empty.
fn split_artist_title(s: &str) -> Option<(String, String)> {
    const SEPS: &[&str] = &[" - ", " – ", " — ", " -- "];
    // Pick the earliest-occurring separator so "A - B - C" splits at the first.
    let hit = SEPS
        .iter()
        .filter_map(|sep| s.find(sep).map(|idx| (idx, *sep)))
        .min_by_key(|(idx, _)| *idx);
    let (idx, sep) = hit?;
    let artist = s[..idx].trim();
    let title = s[idx + sep.len()..].trim();
    if artist.is_empty() || title.is_empty() {
        return None;
    }
    Some((artist.to_string(), title.to_string()))
}

/// Best-guess `(artist, title)` for a SoundCloud track, for feeding a Tidal
/// catalog search. SoundCloud titles are freeform; the dominant convention is
/// `Artist - Title`, frequently with promo tags appended
/// (`Kaskade - 4 AM (Adam K & Soha Remix) [Free Download]`). We strip promo
/// brackets, split on the first spaced dash, and fall back to the uploader as
/// the artist when the title has no dash structure.
pub fn clean_sc_metadata(title: &str, uploader: Option<&str>) -> (String, String) {
    let cleaned = strip_promo_brackets(title);
    match split_artist_title(&cleaned) {
        Some(pair) => pair,
        None => {
            let artist = uploader.map(str::trim).unwrap_or_default().to_string();
            (artist, cleaned)
        }
    }
}

/// A single entry in a playlist.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistEntry {
    pub url: String,
    pub title: String,
    pub duration: Option<f64>,
    pub uploader: Option<String>,
    /// True for SoundCloud tracks that are `AD_SUPPORTED` monetized — SoundCloud
    /// serves those as DRM-encrypted HLS and gates the plain streams to 404, so
    /// yt-dlp cannot download the original. The UI flags these and steers the
    /// user to the Tidal match instead. Defaults false (unknown / downloadable).
    #[serde(default)]
    pub drm: bool,
}

/// Playlist metadata extracted via yt-dlp --flat-playlist.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistInfo {
    pub title: String,
    pub uploader: Option<String>,
    pub entries: Vec<PlaylistEntry>,
    pub playlist_url: String,
}

/// How many per-track SoundCloud metadata lookups to run at once. Each is its
/// own short-lived yt-dlp process; 8 keeps a big set fast without hammering
/// SoundCloud or spawning dozens of processes.
const SC_META_CONCURRENCY: usize = 8;

/// Extract playlist entries without downloading.
///
/// SoundCloud is handled specially — see `extract_soundcloud_playlist`. Every
/// other site populates per-entry `title`/`duration` in the fast
/// `--flat-playlist` listing, so we use that. `sc_cookies_browser` is the
/// browser name to pull SoundCloud cookies from (only used for SoundCloud).
pub async fn extract_playlist(
    ytdlp_path: &PathBuf,
    url: &str,
    sc_cookies_browser: Option<&str>,
) -> Result<PlaylistInfo, AppError> {
    if is_soundcloud_url(url) {
        return extract_soundcloud_playlist(ytdlp_path, url, sc_cookies_browser).await;
    }

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
                drm: false,
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

/// Derive a human-ish title from a SoundCloud track URL when metadata can't be
/// resolved: the last path segment with dashes turned to spaces
/// (`.../never-be-like-you-feat-kai` → `never be like you feat kai`).
///
/// When the segment is a bare numeric track ID — which is all yt-dlp knows for
/// tracks it couldn't fully resolve (private / Go+ / deleted / region-locked) —
/// we return a clearly-flagged label instead of a naked number, so the row
/// reads as "unavailable" rather than looking like corrupt data.
fn slug_to_title(url: &str) -> String {
    let slug = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/')
        .rsplit('/')
        .find(|s| !s.is_empty());
    match slug {
        Some(s) if s.chars().all(|c| c.is_ascii_digit()) => {
            format!("Unavailable SoundCloud track ({})", s)
        }
        Some(s) => {
            let words = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
            if words.is_empty() { "Unknown".to_string() } else { words }
        }
        None => "Unknown".to_string(),
    }
}

/// Append `--cookies-from-browser <browser>` when a non-empty browser is set,
/// so SoundCloud auth-gated tracks resolve. Mirrors the download path.
fn apply_sc_cookies(cmd: &mut Command, browser: Option<&str>) {
    if let Some(b) = browser {
        if !b.is_empty() {
            cmd.arg("--cookies-from-browser").arg(b);
        }
    }
}

/// Result of checking whether the configured browser yields usable, logged-in
/// SoundCloud cookies. `ok` is true only when an actual SoundCloud session is
/// found (an `oauth_token` cookie), which is what unlocks original-file
/// downloads and private / Go+ / region-locked track resolution.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CookieCheck {
    pub ok: bool,
    /// "logged_in" | "not_logged_in" | "no_cookies" | "error"
    pub status: String,
    pub message: String,
    pub cookie_count: usize,
}

/// Validate SoundCloud cookies for `browser`. Works by asking yt-dlp to export
/// the browser's cookie jar (it writes the jar even though it then errors on
/// the missing URL — no network, ~0.5s) and inspecting it for a SoundCloud
/// `oauth_token`. This cleanly separates the three real failure modes: cookies
/// unreadable (e.g. Chrome/Edge DPAPI lock on Windows), cookies readable but
/// not logged in, and a genuine logged-in session.
pub async fn check_soundcloud_cookies(ytdlp_path: &PathBuf, browser: &str) -> CookieCheck {
    if browser.is_empty() {
        return CookieCheck {
            ok: false,
            status: "no_cookies".into(),
            message: "No browser selected — pick the browser you're signed in to SoundCloud with.".into(),
            cookie_count: 0,
        };
    }

    // Unique temp path so concurrent checks don't clobber each other. The jar
    // contains ALL of the browser's cookies, so we delete it immediately after.
    let tmp = std::env::temp_dir().join(format!("wavejack_sc_cookies_{}.txt", std::process::id()));

    let output = Command::new(ytdlp_path)
        .arg("--cookies-from-browser")
        .arg(browser)
        .arg("--cookies")
        .arg(&tmp)
        .arg("--no-warnings")
        .output()
        .await;

    let stderr = output
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
        .unwrap_or_default();

    let jar = tokio::fs::read_to_string(&tmp).await.unwrap_or_default();
    let _ = tokio::fs::remove_file(&tmp).await;

    let cookie_count = jar
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
        .count();
    let has_oauth = jar.lines().any(|l| {
        let low = l.to_ascii_lowercase();
        low.contains("soundcloud.com") && low.contains("oauth_token")
    });

    if has_oauth {
        return CookieCheck {
            ok: true,
            status: "logged_in".into(),
            message: format!(
                "Signed in to SoundCloud via {} ({} cookies). Original-file downloads and private / Go+ tracks will resolve.",
                browser, cookie_count
            ),
            cookie_count,
        };
    }

    // A real cookie-extraction error (yt-dlp prints these as `ERROR:`; the
    // benign "you must provide a URL" note is `yt-dlp: error:`, so it's excluded).
    if let Some(err) = stderr.lines().find(|l| l.contains("ERROR:")) {
        let low = err.to_ascii_lowercase();
        let friendly = if low.contains("dpapi") {
            format!(
                "{}'s cookies are locked by Windows (DPAPI) and can't be read. Use Firefox (recommended), or fully quit {} and try again.",
                browser, browser
            )
        } else if low.contains("unsupported platform") {
            format!("{} isn't available on this system.", browser)
        } else if low.contains("could not find") || low.contains("not find") {
            format!(
                "Couldn't find {}'s cookie database — make sure it's installed and you've opened it at least once.",
                browser
            )
        } else {
            err.split("ERROR:").nth(1).unwrap_or(err).trim().to_string()
        };
        return CookieCheck { ok: false, status: "error".into(), message: friendly, cookie_count };
    }

    if cookie_count == 0 {
        return CookieCheck {
            ok: false,
            status: "no_cookies".into(),
            message: format!("No cookies could be read from {}.", browser),
            cookie_count: 0,
        };
    }

    CookieCheck {
        ok: false,
        status: "not_logged_in".into(),
        message: format!(
            "Read {} cookies from {}, but you're not signed in to SoundCloud there. Sign in at soundcloud.com in {}, then re-test.",
            cookie_count, browser, browser
        ),
        cookie_count,
    }
}

// ------- SoundCloud api-v2 resolution --------------------------------------
//
// yt-dlp's `--flat-playlist` leaves monetized / private / region tracks as bare
// numeric IDs (it can't attach a client_id to a bare-ID URL), which is why they
// showed up as "Unavailable SoundCloud track (id)". SoundCloud's own api-v2 DOES
// resolve those IDs — given a `client_id` scraped from the site's JS (the same
// technique yt-dlp uses internally) — returning the real title / artist /
// permalink. We use it to (a) recover those titles so the track is at least
// Tidal-matchable, and (b) skip the slow per-track yt-dlp resolve for the whole
// playlist. Falls back to yt-dlp when scraping or a lookup fails.

/// Everything between `start` and the next `end` after it.
fn slice_between<'a>(hay: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = hay.find(start)? + start.len();
    let rest = &hay[i..];
    let j = rest.find(end)?;
    Some(&rest[..j])
}

/// Pull a `client_id` out of a SoundCloud JS bundle. Public — pure string
/// parsing, unit-tested.
fn parse_client_id(js: &str) -> Option<String> {
    let id = slice_between(js, "client_id:\"", "\"")
        .or_else(|| slice_between(js, "\"client_id\":\"", "\""))
        .or_else(|| slice_between(js, "client_id=", "&"))?;
    if id.len() >= 20 && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Process-lifetime cache of the scraped client_id (they rotate slowly).
static SC_CLIENT_ID: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);

/// Scrape a public web `client_id` from SoundCloud's asset bundles. `None` if
/// the site layout changed or the network failed — callers fall back to yt-dlp.
async fn soundcloud_client_id(client: &reqwest::Client) -> Option<String> {
    if let Some(id) = SC_CLIENT_ID.lock().await.clone() {
        return Some(id);
    }
    let home = client.get("https://soundcloud.com/").send().await.ok()?.text().await.ok()?;

    // Collect the asset bundle URLs in document order; the client_id lives in
    // one of the later ones, so we probe from the end.
    let mut asset_urls: Vec<String> = Vec::new();
    let mut hay = home.as_str();
    while let Some(pos) = hay.find("https://a-v2.sndcdn.com/assets/") {
        let rest = &hay[pos..];
        let Some(end) = rest.find(".js") else { break };
        asset_urls.push(rest[..end + 3].to_string());
        hay = &rest[end + 3..];
    }

    for url in asset_urls.into_iter().rev() {
        let Ok(resp) = client.get(&url).send().await else { continue };
        let Ok(body) = resp.text().await else { continue };
        if let Some(id) = parse_client_id(&body) {
            *SC_CLIENT_ID.lock().await = Some(id.clone());
            return Some(id);
        }
    }
    None
}

#[derive(serde::Deserialize)]
struct ApiV2Track {
    id: u64,
    #[serde(default)]
    title: String,
    /// Playable duration in milliseconds.
    #[serde(default)]
    duration: u64,
    #[serde(default)]
    permalink_url: Option<String>,
    #[serde(default)]
    user: Option<ApiV2User>,
    /// "AD_SUPPORTED" means DRM-encrypted streams only — not downloadable.
    #[serde(default)]
    monetization_model: Option<String>,
}

#[derive(serde::Deserialize)]
struct ApiV2User {
    #[serde(default)]
    username: String,
}

/// Convert an api-v2 track object into a `PlaylistEntry`, using the real
/// permalink as the download URL and flagging AD_SUPPORTED (DRM) tracks. Returns
/// `None` when the track has no permalink (nothing we can hand to yt-dlp).
fn apiv2_to_entry(t: ApiV2Track) -> Option<PlaylistEntry> {
    let permalink = t.permalink_url?;
    Some(PlaylistEntry {
        url: permalink,
        title: t.title,
        duration: if t.duration > 0 { Some(t.duration as f64 / 1000.0) } else { None },
        uploader: t.user.map(|u| u.username),
        drm: t.monetization_model.as_deref() == Some("AD_SUPPORTED"),
    })
}

/// Resolve a single SoundCloud track URL to a `PlaylistEntry` (title / artist /
/// duration / DRM flag) via api-v2, so the caller can decide whether the SC
/// original is downloadable or the user should be offered the Tidal match.
/// Falls back to a yt-dlp resolve when api-v2 is unavailable.
pub async fn resolve_single_soundcloud(
    ytdlp_path: &PathBuf,
    url: &str,
    cookies_browser: Option<&str>,
) -> PlaylistEntry {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    if let Some(cid) = soundcloud_client_id(&http).await {
        let resolve_url = format!(
            "https://api-v2.soundcloud.com/resolve?url={}&client_id={}",
            urlencoding::encode(url),
            cid
        );
        if let Ok(resp) = http.get(&resolve_url).send().await {
            if resp.status().is_success() {
                if let Ok(t) = resp.json::<ApiV2Track>().await {
                    if let Some(entry) = apiv2_to_entry(t) {
                        return entry;
                    }
                }
            }
        }
    }
    // api-v2 unavailable — fall back to a yt-dlp resolve (won't know DRM, but at
    // least returns real metadata for non-gated tracks).
    resolve_sc_track(ytdlp_path, url.to_string(), cookies_browser).await
}

/// Batch-resolve SoundCloud track IDs via api-v2 (50 per request). Returns a
/// map of id → fully-populated `PlaylistEntry` (with the real permalink as the
/// download URL). IDs that don't come back are simply absent.
async fn resolve_sc_ids_apiv2(
    client: &reqwest::Client,
    client_id: &str,
    ids: &[u64],
) -> std::collections::HashMap<u64, PlaylistEntry> {
    let mut out = std::collections::HashMap::new();
    for chunk in ids.chunks(50) {
        let joined = chunk.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let url = format!(
            "https://api-v2.soundcloud.com/tracks?ids={}&client_id={}",
            joined, client_id
        );
        let Ok(resp) = client.get(&url).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(tracks) = resp.json::<Vec<ApiV2Track>>().await else { continue };
        for t in tracks {
            let id = t.id;
            if let Some(entry) = apiv2_to_entry(t) {
                out.insert(id, entry);
            }
        }
    }
    out
}

/// Resolve one SoundCloud track's real metadata. Never fails — on any error
/// (network, geo-block, dead track) it returns an entry titled from the URL
/// slug so the row still shows up in the preview.
async fn resolve_sc_track(
    ytdlp_path: &PathBuf,
    page_url: String,
    cookies_browser: Option<&str>,
) -> PlaylistEntry {
    let fallback = || PlaylistEntry {
        url: page_url.clone(),
        title: slug_to_title(&page_url),
        duration: None,
        uploader: None,
        drm: false,
    };

    let mut cmd = Command::new(ytdlp_path);
    cmd.args(["-J", "--no-warnings", "--no-playlist", &page_url]);
    apply_sc_cookies(&mut cmd, cookies_browser);
    let Ok(output) = cmd.output().await else {
        return fallback();
    };
    if !output.status.success() {
        return fallback();
    }
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return fallback();
    };

    PlaylistEntry {
        url: json["webpage_url"].as_str().unwrap_or(&page_url).to_string(),
        title: json["title"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| slug_to_title(&page_url)),
        duration: json["duration"].as_f64(),
        uploader: json["uploader"].as_str().map(|s| s.to_string()),
        // yt-dlp only resolves this track if it wasn't DRM-gated in the first
        // place, so anything reaching here is treated as downloadable.
        drm: false,
    }
}

/// SoundCloud's flat listing omits per-track titles/durations, so we do a fast
/// flat pass to get the ordered page URLs, then resolve each track's metadata
/// concurrently (bounded). Individual failures degrade to a slug-derived title
/// instead of failing the whole playlist — that avoids the old behavior where a
/// single dead track sank extraction and the UI silently downloaded the URL.
async fn extract_soundcloud_playlist(
    ytdlp_path: &PathBuf,
    url: &str,
    cookies_browser: Option<&str>,
) -> Result<PlaylistInfo, AppError> {
    let mut flat_cmd = Command::new(ytdlp_path);
    flat_cmd.args(["--flat-playlist", "-J", "--no-warnings", url]);
    apply_sc_cookies(&mut flat_cmd, cookies_browser);
    let output = flat_cmd
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

    // (track id, page URL) for each flat entry. The id lets us batch-resolve via
    // api-v2; the URL is the yt-dlp fallback.
    let flat: Vec<(Option<u64>, String)> = entries_arr
        .iter()
        .filter_map(|e| {
            let url = e["webpage_url"]
                .as_str()
                .or_else(|| e["url"].as_str())
                .map(|s| s.to_string())?;
            let id = e["id"]
                .as_u64()
                .or_else(|| e["id"].as_str().and_then(|s| s.parse::<u64>().ok()));
            Some((id, url))
        })
        .collect();

    if flat.is_empty() {
        return Err(AppError::YtDlpFailed("Playlist has no entries".to_string()));
    }

    // Batch-resolve as many tracks as possible via api-v2 (fast, one HTTP call
    // per 50, and it recovers monetized/private tracks yt-dlp leaves as bare
    // IDs). Anything it can't return falls back to a per-track yt-dlp resolve.
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let ids: Vec<u64> = flat.iter().filter_map(|(id, _)| *id).collect();
    let resolved = match soundcloud_client_id(&http).await {
        Some(cid) => resolve_sc_ids_apiv2(&http, &cid, &ids).await,
        None => std::collections::HashMap::new(),
    };

    // Preserve playlist order; api-v2 hits are instant, misses fall back to yt-dlp.
    let entries: Vec<PlaylistEntry> = futures_util::stream::iter(flat)
        .map(|(id, url)| {
            let hit = id.and_then(|i| resolved.get(&i).cloned());
            async move {
                match hit {
                    Some(entry) => entry,
                    None => resolve_sc_track(ytdlp_path, url, cookies_browser).await,
                }
            }
        })
        .buffered(SC_META_CONCURRENCY)
        .collect()
        .await;

    Ok(PlaylistInfo {
        title: playlist_title,
        uploader,
        entries,
        playlist_url: url.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::clean_sc_metadata;

    #[test]
    fn splits_artist_dash_title() {
        assert_eq!(
            clean_sc_metadata("Kaskade - 4 AM", None),
            ("Kaskade".to_string(), "4 AM".to_string())
        );
    }

    #[test]
    fn strips_free_download_promo_but_keeps_remix() {
        assert_eq!(
            clean_sc_metadata("Kaskade - 4 AM (Adam K & Soha Remix) [Free Download]", None),
            ("Kaskade".to_string(), "4 AM (Adam K & Soha Remix)".to_string())
        );
    }

    #[test]
    fn keeps_remix_descriptor() {
        let (_, title) = clean_sc_metadata("ODESZA - Sun Models (Bear Grillz Remix)", None);
        assert_eq!(title, "Sun Models (Bear Grillz Remix)");
    }

    #[test]
    fn falls_back_to_uploader_without_dash() {
        assert_eq!(
            clean_sc_metadata("Strobe", Some("deadmau5")),
            ("deadmau5".to_string(), "Strobe".to_string())
        );
    }

    #[test]
    fn no_dash_no_uploader_yields_empty_artist() {
        assert_eq!(
            clean_sc_metadata("Some Bootleg", None),
            (String::new(), "Some Bootleg".to_string())
        );
    }

    #[test]
    fn handles_unicode_en_dash() {
        assert_eq!(
            clean_sc_metadata("Lane 8 – Brightest Lights", None),
            ("Lane 8".to_string(), "Brightest Lights".to_string())
        );
    }

    #[test]
    fn drops_trailing_promo_bracket_and_collapses_ws() {
        assert_eq!(
            clean_sc_metadata("Rezz - Edge [OUT NOW]", None),
            ("Rezz".to_string(), "Edge".to_string())
        );
    }

    #[test]
    fn splits_at_first_dash_when_multiple() {
        assert_eq!(
            clean_sc_metadata("Artist - Title - Bootleg", None),
            ("Artist".to_string(), "Title - Bootleg".to_string())
        );
    }

    #[test]
    fn slug_numeric_id_is_flagged_unavailable() {
        assert_eq!(
            super::slug_to_title("https://api.soundcloud.com/tracks/2095011300"),
            "Unavailable SoundCloud track (2095011300)"
        );
    }

    #[test]
    fn parses_client_id_from_js_bundle() {
        let js = r#"...,client_id:"O7atZytS4Rr0Bq0jQ235nWm4T9tHzYqM",env:"production"..."#;
        assert_eq!(
            super::parse_client_id(js).as_deref(),
            Some("O7atZytS4Rr0Bq0jQ235nWm4T9tHzYqM")
        );
    }

    #[test]
    fn rejects_short_or_missing_client_id() {
        assert_eq!(super::parse_client_id("no id here"), None);
        assert_eq!(super::parse_client_id(r#"client_id:"tooShort""#), None);
    }

    #[test]
    fn slug_permalink_becomes_words() {
        assert_eq!(
            super::slug_to_title("https://soundcloud.com/flume/never-be-like-you-feat-kai"),
            "never be like you feat kai"
        );
    }

    #[test]
    fn uploader_whitespace_is_trimmed() {
        assert_eq!(
            clean_sc_metadata("Untitled", Some("  Some Label  ")),
            ("Some Label".to_string(), "Untitled".to_string())
        );
    }
}

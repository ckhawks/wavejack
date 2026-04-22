// tidal_download.rs — Shell out to `tidal-dl-ng` to fetch matched Tidal
// tracks. Mirrors rekordbox-mem/src/extractor/tools/tidal_batch_download.py
// but per-track instead of batched, so each download gets its own progress
// events and can be surfaced in the existing DownloadQueue.
//
// We don't reimplement Tidal's stream decryption in Rust — `tidal-dl-ng`
// solves MPEG-DASH + DRM for us. The user logs in to tidal-dl-ng separately
// (our Wavejack-side Tidal auth is used only for catalog search).

use crate::error::AppError;
use crate::ytdlp::DownloadStatusEvent;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use lofty::file::AudioFile;
use lofty::probe::Probe;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Emitted after a Tidal download lands, once we've probed the final file.
/// The UI pre-populates `format: "flac"` at queue time (the *intended* tier),
/// but Tidal may serve AAC for tracks without a lossless master — this event
/// replaces that intent with the ground truth read from the actual file.
#[derive(Serialize, Clone)]
struct DownloadEnrichedEvent<'a> {
    id: &'a str,
    audio_format: String,
    bitrate_kbps: u32,
}
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[cfg(target_os = "windows")]
const TIDAL_DL_BIN: &str = "tidal-dl-ng.exe";
#[cfg(not(target_os = "windows"))]
const TIDAL_DL_BIN: &str = "tidal-dl-ng";

fn find_bin() -> Result<PathBuf, AppError> {
    which::which(TIDAL_DL_BIN).or_else(|_| which::which("tidal-dl-ng")).map_err(|_| {
        AppError::Settings(
            "tidal-dl-ng not found on PATH. Install with `pip install tidal-dl-ng` \
             (or pipx) and log in with `tidal-dl-ng login` before downloading."
                .into(),
        )
    })
}

/// Set tidal-dl-ng's persistent config: output folder + embed metadata/cover.
/// Run once per download batch from the caller.
pub async fn configure_for_batch(output_dir: &Path) -> Result<(), AppError> {
    let bin = find_bin()?;
    tokio::fs::create_dir_all(output_dir).await?;

    // tidal-dl-ng maintains its own `downloaded_history.json`. Even with
    // `skip_existing: False` it still *reads* this file on startup, and if
    // it's malformed (from a partial write or version mismatch) the whole
    // download crashes with HistoryFormatError. Wavejack tracks completion
    // via its own DB + filesystem snapshot, so nuke the CLI's history each
    // batch to keep it from ever getting in the way.
    if let Some(home) = dirs::home_dir() {
        let hist = home.join(".config").join("tidal_dl_ng-dev").join("downloaded_history.json");
        if hist.exists() {
            let _ = tokio::fs::remove_file(&hist).await;
        }
    }
    for (key, value) in [
        ("download_base_path", output_dir.to_string_lossy().to_string()),
        // Force the best tier Tidal has per track — tidal-dl-ng falls back
        // per-track when a tier isn't available, so HI_RES_LOSSLESS gives
        // 24-bit FLAC where offered, 16-bit FLAC for LOSSLESS-only tracks,
        // and AAC for HIGH-only. The default is HIGH (AAC 320), which is
        // why downloads come out as .m4a without this.
        ("quality_audio", "HI_RES_LOSSLESS".into()),
        // Drop tidal-dl-ng's default "Tracks/" subfolder — Wavejack's musicDir
        // is already the library root, and Wavejack's own playlist folders
        // organize tracks separately.
        ("format_track", "{artist_name} - {track_title}".into()),
        // Wavejack maintains its own download history + filesystem check, and
        // tidal-dl-ng's history records entries even when the download never
        // actually wrote a file (silent-exit-0 cases) — stale history entries
        // would then mask real retries. Defer skip logic to Wavejack.
        ("skip_existing", "False".into()),
        // Defaults already enable these, but set explicitly in case the user
        // flipped them off in a prior session.
        ("metadata_cover_embed", "True".into()),
        ("metadata_write", "True".into()),
        ("metadata_lyrics_embed", "True".into()),
    ] {
        let status = Command::new(&bin)
            .args(["cfg", key, &value])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| AppError::Settings(format!("tidal-dl-ng cfg failed: {}", e)))?;
        if !status.success() {
            return Err(AppError::Settings(format!(
                "tidal-dl-ng cfg {} exited with {}", key, status
            )));
        }
    }
    Ok(())
}

/// Walk output_dir and collect every audio-like file's path. Used to diff
/// before/after the download so we can surface the resulting file.
fn snapshot_files(dir: &Path) -> HashSet<PathBuf> {
    let mut out = HashSet::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&p) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if let Ok(ft) = e.file_type() {
                if ft.is_dir() {
                    stack.push(path);
                } else if ft.is_file() {
                    let ext_ok = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| matches!(
                            e.to_ascii_lowercase().as_str(),
                            "flac" | "m4a" | "mp4" | "mp3" | "ogg" | "opus" | "wav"
                        ))
                        .unwrap_or(false);
                    if ext_ok {
                        out.insert(path);
                    }
                }
            }
        }
    }
    out
}

fn emit(app: &AppHandle, id: &str, ev: DownloadStatusEvent) {
    let _ = app.emit("download-status", ev);
    // Keep the event noise out of the logs once per line is enough.
    let _ = id;
}

/// Download a single Tidal track. Blocks until the tidal-dl-ng subprocess
/// exits. Emits "download-status" events consistent with the yt-dlp path so
/// the existing queue UI renders progress.
pub async fn download_one(
    app: &AppHandle,
    download_id: &str,
    tidal_url: &str,
    output_dir: &Path,
    title_hint: Option<&str>,
) -> Result<PathBuf, AppError> {
    let bin = find_bin()?;
    tokio::fs::create_dir_all(output_dir).await?;

    let before_files = snapshot_files(output_dir);
    let started_at = SystemTime::now();

    emit(app, download_id, DownloadStatusEvent {
        id: download_id.to_string(),
        status: "downloading".into(),
        progress: 0.0,
        message: format!(
            "Starting Tidal download{}",
            title_hint.map(|t| format!(": {}", t)).unwrap_or_default()
        ),
        backend: "tidal-dl-ng".into(),
        title: title_hint.map(String::from),
        file_path: None,
        cover_art_base64: None,
    });

    let mut child = Command::new(&bin)
        .args(["dl", tidal_url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Settings(format!("spawn tidal-dl-ng failed: {}", e)))?;

    let stdout = child.stdout.take().ok_or_else(|| AppError::Settings("no stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::Settings("no stderr".into()))?;

    // Accumulate every line so we can echo tidal-dl-ng's actual output back
    // into the error message when something goes wrong — running from a GUI
    // subprocess loses console visibility, so this is the only way to see
    // what the CLI actually said.
    let stdout_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let app_stdout = app.clone();
    let id_stdout = download_id.to_string();
    let title_stdout = title_hint.map(String::from);
    let stdout_buf_clone = stdout_buf.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut last_emit = std::time::Instant::now();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            eprintln!("[tidal-dl-ng stdout] {}", trimmed);
            if let Ok(mut buf) = stdout_buf_clone.lock() {
                buf.push(trimmed.to_string());
            }
            // Throttle to ~10/s so we don't flood the IPC channel.
            if last_emit.elapsed() < std::time::Duration::from_millis(100) { continue; }
            last_emit = std::time::Instant::now();
            let _ = app_stdout.emit("download-status", DownloadStatusEvent {
                id: id_stdout.clone(),
                status: "downloading".into(),
                progress: 50.0,
                message: trimmed.chars().take(160).collect(),
                backend: "tidal-dl-ng".into(),
                title: title_stdout.clone(),
                file_path: None,
                cover_art_base64: None,
            });
        }
    });

    let stderr_buf_clone = stderr_buf.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                eprintln!("[tidal-dl-ng stderr] {}", line);
                if let Ok(mut buf) = stderr_buf_clone.lock() {
                    buf.push(line);
                }
            }
        }
    });

    let exit = child.wait().await.map_err(|e| AppError::Settings(format!("wait failed: {}", e)))?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    if !exit.success() {
        let stdout_tail: String = stdout_buf
            .lock().ok()
            .map(|b| b.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        let stderr_tail: String = stderr_buf
            .lock().ok()
            .map(|b| b.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        let msg = format!(
            "tidal-dl-ng exited with {}. stdout: [{}] stderr: [{}]",
            exit, stdout_tail, stderr_tail,
        );
        emit(app, download_id, DownloadStatusEvent {
            id: download_id.to_string(),
            status: "error".into(),
            progress: 0.0,
            message: msg.clone(),
            backend: "tidal-dl-ng".into(),
            title: title_hint.map(String::from),
            file_path: None,
            cover_art_base64: None,
        });
        return Err(AppError::Settings(msg));
    }

    // Find the file tidal-dl-ng just wrote by diffing against the snapshot.
    // Prefer files mtime >= started_at in case the diff misses something
    // (e.g. the track was already there and got overwritten).
    let after_files = snapshot_files(output_dir);
    let new_file = after_files
        .difference(&before_files)
        .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())
        .cloned()
        .or_else(|| {
            after_files
                .iter()
                .filter_map(|p| {
                    let m = p.metadata().ok()?.modified().ok()?;
                    (m >= started_at).then_some((p.clone(), m))
                })
                .max_by_key(|(_, m)| *m)
                .map(|(p, _)| p)
        });

    let file_path_str = new_file.as_ref().map(|p| p.to_string_lossy().to_string());
    emit(app, download_id, DownloadStatusEvent {
        id: download_id.to_string(),
        status: "complete".into(),
        progress: 100.0,
        message: "Download complete".into(),
        backend: "tidal-dl-ng".into(),
        title: title_hint.map(String::from),
        file_path: file_path_str,
        cover_art_base64: None,
    });

    // Probe the actual file for its real format + bitrate. Tidal serves AAC
    // for some tracks even when quality_audio is HI_RES_LOSSLESS, so the
    // queue should show what we got, not what we asked for.
    if let Some(path) = new_file.as_ref() {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        let probed = Probe::open(path).ok().and_then(|p| p.read().ok());
        let (bitrate_reported, duration_secs) = probed
            .as_ref()
            .map(|t| {
                let p = t.properties();
                (p.audio_bitrate().unwrap_or(0), p.duration().as_secs())
            })
            .unwrap_or((0, 0));
        // lofty reports 0 on some MP4 variants (MQA, Dolby Atmos). Fall back
        // to size/duration so the user still sees a ballpark number.
        let bitrate = if bitrate_reported > 0 {
            bitrate_reported
        } else if duration_secs > 0 {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            ((size * 8) / duration_secs / 1000) as u32
        } else {
            0
        };
        let _ = app.emit("download-enriched", DownloadEnrichedEvent {
            id: download_id,
            audio_format: ext,
            bitrate_kbps: bitrate,
        });
    }

    new_file.ok_or_else(|| {
        // Include the tail of tidal-dl-ng's actual stdout + stderr so the UI
        // (and the tauri dev terminal) can tell us why it bailed.
        let stdout_tail: String = stdout_buf
            .lock().ok()
            .map(|b| b.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        let stderr_tail: String = stderr_buf
            .lock().ok()
            .map(|b| b.iter().rev().take(6).rev().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default();
        let msg = format!(
            "tidal-dl-ng exited 0 but wrote no file. stdout: [{}] stderr: [{}]",
            stdout_tail, stderr_tail,
        );
        emit(app, download_id, DownloadStatusEvent {
            id: download_id.to_string(),
            status: "error".into(),
            progress: 0.0,
            message: msg.clone(),
            backend: "tidal-dl-ng".into(),
            title: title_hint.map(String::from),
            file_path: None,
            cover_art_base64: None,
        });
        AppError::Settings(msg)
    })
}

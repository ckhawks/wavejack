// lib.rs — The main Tauri plugin/command registration file.
// This is where we:
//   1. Define all the #[tauri::command] functions (the bridge between Rust and JS)
//   2. Register plugins (store, dialog, shell)
//   3. Build and run the Tauri app
//
// Each command function is async so it doesn't block the main thread.
// Tauri automatically handles serialization/deserialization of arguments and return values.

mod cobalt;
mod cover_art;
mod database;
mod discover;
mod downloader;
mod error;
mod library;
mod metadata;
mod remote;
mod tags;
mod waveform;
mod ytdlp;

use database::{Database, DownloadRecord};
use error::AppError;
use id3::TagLike;
use metadata::RateLimiter;
use tauri::{Emitter, Manager};
use tauri_plugin_store::StoreExt;

// ========================================================================
// Tauri Commands — these are callable from JavaScript via invoke()
// ========================================================================

/// Start downloading a URL. This spawns the download in a background task
/// so it doesn't block the IPC channel (otherwise the frontend would freeze).
///
/// Called from JS: invoke("start_download", { id, url, format })
#[tauri::command]
async fn start_download(
    app: tauri::AppHandle,
    id: String,
    url: String,
    format: String,
    playlist_title: Option<String>,
    destination: Option<String>,
) -> Result<(), AppError> {
    // Resolve the output directory based on the destination choice.
    let dest = destination.unwrap_or_else(|| "downloads".to_string());
    let output_dir = match dest.as_str() {
        "music" => get_store_value(&app, "musicDir")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_music_dir),
        _ => get_store_value(&app, "outputDir")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(default_output_dir),
    };
    let cobalt_url = get_store_value(&app, "cobaltUrl")
        .unwrap_or_default();

    let pl_title = playlist_title.unwrap_or_default();
    let output_dir_for_scan = output_dir.clone();
    let dest_clone = dest.clone();

    // Spawn the download as a background task.
    // We use tauri::async_runtime::spawn so it runs independently.
    // This means start_download returns immediately while the download continues.
    tauri::async_runtime::spawn(async move {
        let result = downloader::download(
            &app,
            &id,
            &url,
            &format,
            &output_dir,
            &cobalt_url,
        )
        .await;

        // Persist result to database
        let db = app.state::<Database>();
        match result {
            Ok(dl) => {
                let record = DownloadRecord {
                    id: id.clone(),
                    url: url.clone(),
                    format: format.clone(),
                    status: "complete".to_string(),
                    title: dl.title.unwrap_or_default(),
                    artist: String::new(),
                    album: String::new(),
                    cover_art_path: String::new(),
                    file_path: dl.file_path.unwrap_or_default(),
                    backend: dl.backend,
                    message: "Download complete!".to_string(),
                    playlist_title: pl_title.clone(),
                    created_at: database::now_timestamp(),
                    cover_art_base64: dl.cover_art_base64.unwrap_or_default(),
                };
                if let Err(e) = db.insert_or_update(&record) {
                    eprintln!("Failed to save download record: {}", e);
                }

                // If this went into the music destination and that folder
                // is part of the library, refresh its cache so the new
                // track shows up without a manual rescan.
                if dest_clone == "music" {
                    if let Ok(folders) = db.list_library_folders() {
                        for folder in folders {
                            if output_dir_for_scan.starts_with(&folder) {
                                let dir = std::path::PathBuf::from(&folder);
                                let app_inner = app.clone();
                                tokio::task::spawn_blocking(move || {
                                    let db = app_inner.state::<Database>();
                                    library::scan_folder_incremental(&dir, &db);
                                    let _ = app_inner.emit("library-updated", ());
                                });
                                break;
                            }
                        }
                    }
                }
            }
            Err(ref e) => {
                let record = DownloadRecord {
                    id: id.clone(),
                    url: url.clone(),
                    format: format.clone(),
                    status: "error".to_string(),
                    title: String::new(),
                    artist: String::new(),
                    album: String::new(),
                    cover_art_path: String::new(),
                    file_path: String::new(),
                    backend: String::new(),
                    message: e.to_string(),
                    playlist_title: pl_title.clone(),
                    created_at: database::now_timestamp(),
                    cover_art_base64: String::new(),
                };
                if let Err(db_err) = db.insert_or_update(&record) {
                    eprintln!("Failed to save error record: {}", db_err);
                }
                eprintln!("Download failed for {}: {}", url, e);
            }
        }
    });

    Ok(())
}

/// Check if yt-dlp is available, and download it if not.
/// Returns the path to the yt-dlp binary.
///
/// Called from JS: invoke("ensure_ytdlp_ready")
#[tauri::command]
async fn ensure_ytdlp_ready(app: tauri::AppHandle) -> Result<String, AppError> {
    let path = ytdlp::ensure_ytdlp(&app).await?;
    Ok(path.to_string_lossy().to_string())
}

/// Get all settings as a JSON object.
/// We read from Tauri's plugin-store which persists data to disk.
///
/// Called from JS: invoke("get_settings")
#[tauri::command]
async fn get_settings(app: tauri::AppHandle) -> Result<serde_json::Value, AppError> {
    // Build a settings object from stored values (with defaults for missing keys)
    let output_dir = get_store_value(&app, "outputDir")
        .unwrap_or_else(default_output_dir);
    let music_dir = get_store_value(&app, "musicDir")
        .unwrap_or_else(default_music_dir);
    let cobalt_url = get_store_value(&app, "cobaltUrl")
        .unwrap_or_default();
    let format = get_store_value(&app, "format")
        .unwrap_or_else(|| "mp3".to_string());
    let player_volume = get_store_value(&app, "playerVolume");
    let lastfm_api_key = get_store_value(&app, "lastfmApiKey")
        .unwrap_or_default();
    let last_destination = get_store_value(&app, "lastDestination")
        .unwrap_or_else(|| "downloads".to_string());
    let library_columns = get_store_value(&app, "libraryColumns").unwrap_or_default();
    let library_sort = get_store_value(&app, "librarySort").unwrap_or_default();
    let shuffle = get_store_value(&app, "shuffle").unwrap_or_else(|| "0".to_string());
    Ok(serde_json::json!({
        "outputDir": output_dir,
        "musicDir": music_dir,
        "cobaltUrl": cobalt_url,
        "format": format,
        "playerVolume": player_volume,
        "lastfmApiKey": lastfm_api_key,
        "lastDestination": last_destination,
        "libraryColumns": library_columns,
        "librarySort": library_sort,
        "shuffle": shuffle,
    }))
}

/// Update a single setting by key.
/// The value is stored persistently using Tauri's plugin-store.
///
/// Called from JS: invoke("set_setting", { key, value })
#[tauri::command]
async fn set_setting(
    app: tauri::AppHandle,
    key: String,
    value: String,
) -> Result<(), AppError> {
    let store = app.store("settings.json")
        .map_err(|e| AppError::Settings(e.to_string()))?;

    store.set(&key, serde_json::Value::String(value));
    store.save()
        .map_err(|e| AppError::Settings(e.to_string()))?;

    Ok(())
}

/// Open a file with the system's default application (e.g., play mp3 in default player).
///
/// Called from JS: invoke("open_file", { path })
#[tauri::command]
async fn open_file(path: String) -> Result<(), AppError> {
    // Use the platform's native "open" command:
    //   Windows: cmd /c start "" "path"
    //   macOS:   open "path"
    //   Linux:   xdg-open "path"
    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file: {}", e)))?;
    }
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file: {}", e)))?;
    }
    #[cfg(target_os = "linux")]
    {
        tokio::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to open file: {}", e)))?;
    }
    Ok(())
}

/// Update MP3 metadata (ID3 tags) and optionally rename the file.
/// Also handles auto-naming ("Artist - Title.mp3") and updates the database.
/// Returns the new file path (which may differ if renamed).
///
/// Called from JS: invoke("update_mp3_metadata", { id, path, title, artist, newFilename })
#[tauri::command]
async fn update_mp3_metadata(
    app: tauri::AppHandle,
    id: String,
    path: String,
    title: String,
    artist: String,
    new_filename: String,
) -> Result<String, AppError> {
    let file_path = std::path::PathBuf::from(&path);

    // Write ID3 tags
    let mut tag = id3::Tag::read_from_path(&file_path).unwrap_or_else(|_| id3::Tag::new());
    if !title.is_empty() {
        tag.set_title(&title);
    }
    if !artist.is_empty() {
        tag.set_artist(&artist);
    }
    tag.write_to_path(&file_path, id3::Version::Id3v24)
        .map_err(|e| AppError::Io(format!("Failed to write ID3 tags: {}", e)))?;

    // Determine target filename
    let current_filename = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    let target_filename = if !new_filename.is_empty() && new_filename != current_filename {
        // User explicitly changed the filename
        new_filename
    } else if !artist.is_empty() && !title.is_empty() {
        // Auto-name: "Artist - Title.mp3"
        let auto_name = format!("{} - {}.mp3", sanitize_filename(&artist), sanitize_filename(&title));
        if auto_name != current_filename { auto_name } else { current_filename.clone() }
    } else {
        current_filename.clone()
    };

    // Rename file if needed
    let final_path = if target_filename != current_filename {
        let new_path = file_path.with_file_name(&target_filename);
        tokio::fs::rename(&file_path, &new_path)
            .await
            .map_err(|e| AppError::Io(format!("Failed to rename file: {}", e)))?;
        new_path.to_string_lossy().to_string()
    } else {
        path.clone()
    };

    // Update database record
    let db = app.state::<Database>();
    if let Err(e) = db.update_metadata(&id, &title, &artist, &final_path) {
        eprintln!("Failed to update DB metadata: {}", e);
    }

    Ok(final_path)
}

/// Reveal a file in the system file explorer (highlight it in the folder).
///
/// Called from JS: invoke("reveal_file", { path })
#[tauri::command]
async fn reveal_file(path: String) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        // explorer /select,"path" opens Explorer with the file highlighted
        tokio::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to reveal file: {}", e)))?;
    }
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| AppError::Io(format!("Failed to reveal file: {}", e)))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Open the parent directory
        if let Some(parent) = std::path::Path::new(&path).parent() {
            tokio::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| AppError::Io(format!("Failed to reveal file: {}", e)))?;
        }
    }
    Ok(())
}

// ========================================================================
// Download History Commands
// ========================================================================

/// Get all download history records. Checks file existence, marks missing files,
/// and reads embedded album art from MP3 ID3 tags.
#[tauri::command]
async fn get_download_history(
    app: tauri::AppHandle,
) -> Result<Vec<DownloadRecord>, AppError> {
    let db = app.state::<Database>();
    let mut records = db.get_all().map_err(|e| AppError::Settings(e.to_string()))?;

    for record in &mut records {
        if record.status == "complete" && !record.file_path.is_empty() {
            let path = std::path::Path::new(&record.file_path);
            if !path.exists() {
                record.status = "file_missing".to_string();
                continue;
            }
            // Read embedded cover art from MP3 files
            if record.format == "mp3" {
                if let Ok(tag) = id3::Tag::read_from_path(path) {
                    if let Some(pic) = tag.pictures().next() {
                        use base64::Engine;
                        record.cover_art_base64 =
                            base64::engine::general_purpose::STANDARD.encode(&pic.data);
                    }
                }
            }
        }
    }

    Ok(records)
}

/// Remove a single download history record.
#[tauri::command]
async fn remove_download_history(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.remove(&id).map_err(|e| AppError::Settings(e.to_string()))?;
    Ok(())
}

/// Clear all download history.
#[tauri::command]
async fn clear_download_history(
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.clear_all().map_err(|e| AppError::Settings(e.to_string()))?;
    Ok(())
}

// ========================================================================
// Metadata Commands
// ========================================================================

/// Search MusicBrainz for metadata matches.
#[tauri::command]
async fn fetch_metadata(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<metadata::MetadataMatch>, AppError> {
    let rate_limiter = app.state::<RateLimiter>();
    metadata::search_musicbrainz(&query, &rate_limiter).await
}

/// Apply metadata from MusicBrainz to a downloaded MP3 file.
#[tauri::command]
async fn apply_metadata(
    app: tauri::AppHandle,
    id: String,
    path: String,
    title: String,
    artist: String,
    album: String,
    release_mbid: String,
) -> Result<metadata::AppliedMetadata, AppError> {
    let rate_limiter = app.state::<RateLimiter>();
    let result = metadata::apply_metadata_to_file(
        &path,
        &title,
        &artist,
        &album,
        &release_mbid,
        &rate_limiter,
    )
    .await?;

    // Update database
    let db = app.state::<Database>();
    if let Err(e) = db.update_full_metadata(
        &id,
        &result.title,
        &result.artist,
        &result.album,
        "",
        &result.new_file_path,
    ) {
        eprintln!("Failed to update DB metadata: {}", e);
    }

    Ok(result)
}

// ========================================================================
// Audio Extraction Commands
// ========================================================================

/// Extract audio from a video file (e.g. MP4) and save as MP3.
/// Uses ffmpeg, which must be available on PATH.
/// Returns the path to the created MP3 file.
///
/// Called from JS: invoke("extract_audio", { id, inputPath })
#[tauri::command]
async fn extract_audio(app: tauri::AppHandle, id: String, input_path: String) -> Result<String, AppError> {
    let input = std::path::PathBuf::from(&input_path);
    if !input.exists() {
        return Err(AppError::Io(format!("File not found: {}", input_path)));
    }

    // Build output path: same directory, same name, .mp3 extension
    let output = input.with_extension("mp3");
    let output_str = output.to_string_lossy().to_string();

    // Don't overwrite an existing mp3
    if output.exists() {
        return Err(AppError::Io(format!(
            "MP3 already exists: {}",
            output_str
        )));
    }

    // Find ffmpeg on PATH
    let ffmpeg_path = which::which("ffmpeg")
        .map_err(|_| AppError::Io("ffmpeg not found on PATH. Please install ffmpeg.".into()))?;

    let title = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // Probe input duration using ffprobe so we can report real progress
    let duration_secs = probe_duration(&ffmpeg_path, &input_path).await;

    // Emit initial status
    let _ = app.emit(
        "download-status",
        ytdlp::DownloadStatusEvent {
            id: id.clone(),
            status: "converting".into(),
            progress: 0.0,
            message: "Extracting audio...".into(),
            backend: "ffmpeg".into(),
            title: Some(title.clone()),
            file_path: None,
            cover_art_base64: None,
        },
    );

    // Run ffmpeg with -progress pipe:1 for real-time progress on stdout.
    // Progress lines look like: out_time_us=12345678
    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.args([
        "-i",
        &input_path,
        "-vn",
        "-acodec",
        "libmp3lame",
        "-q:a",
        "0",
        "-progress",
        "pipe:1",
        "-nostats",
        &output_str,
    ]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Io(format!("Failed to run ffmpeg: {}", e)))?;

    // Stream stdout and parse progress
    if let Some(stdout) = child.stdout.take() {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = tokio::io::AsyncBufReadExt::lines(reader);
        let app_ref = app.clone();
        let id_ref = id.clone();
        let title_ref = title.clone();

        while let Ok(Some(line)) = lines.next_line().await {
            // ffmpeg -progress outputs: out_time_us=<microseconds>
            if let Some(us_str) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us_str.trim().parse::<i64>() {
                    if us > 0 {
                        let elapsed_secs = us as f64 / 1_000_000.0;
                        let percent = if let Some(dur) = duration_secs {
                            ((elapsed_secs / dur) * 100.0).min(99.0)
                        } else {
                            // No duration known — show indeterminate-ish progress
                            50.0
                        };
                        let _ = app_ref.emit(
                            "download-status",
                            ytdlp::DownloadStatusEvent {
                                id: id_ref.clone(),
                                status: "converting".into(),
                                progress: percent,
                                message: format!(
                                    "Extracting audio... {}%",
                                    percent as u32
                                ),
                                backend: "ffmpeg".into(),
                                title: Some(title_ref.clone()),
                                file_path: None,
                                cover_art_base64: None,
                            },
                        );
                    }
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Io(format!("Failed to wait for ffmpeg: {}", e)))?;

    if !status.success() {
        let _ = app.emit(
            "download-status",
            ytdlp::DownloadStatusEvent {
                id: id.clone(),
                status: "error".into(),
                progress: 0.0,
                message: "Extraction failed".into(),
                backend: "ffmpeg".into(),
                title: None,
                file_path: None,
                cover_art_base64: None,
            },
        );
        return Err(AppError::Io("ffmpeg exited with an error".into()));
    }

    let _ = app.emit(
        "download-status",
        ytdlp::DownloadStatusEvent {
            id: id.clone(),
            status: "complete".into(),
            progress: 100.0,
            message: "Audio extracted!".into(),
            backend: "ffmpeg".into(),
            title: Some(title.clone()),
            file_path: Some(output_str.clone()),
            cover_art_base64: None,
        },
    );

    // Save to download history
    let db = app.state::<Database>();
    let record = DownloadRecord {
        id,
        url: input_path,
        format: "mp3".to_string(),
        status: "complete".to_string(),
        title,
        artist: String::new(),
        album: String::new(),
        cover_art_path: String::new(),
        file_path: output_str.clone(),
        backend: "ffmpeg".to_string(),
        message: "Audio extracted!".to_string(),
        playlist_title: String::new(),
        created_at: database::now_timestamp(),
        cover_art_base64: String::new(),
    };
    if let Err(e) = db.insert_or_update(&record) {
        eprintln!("Failed to save extraction record: {}", e);
    }

    Ok(output_str)
}

// ========================================================================
// Search Commands
// ========================================================================

/// Search YouTube and SoundCloud for tracks matching a query.
/// Returns up to 5 results per source, deduped by title similarity.
///
/// Called from JS: invoke("search_sources", { query })
#[tauri::command]
async fn search_sources(query: String) -> Result<Vec<discover::SearchResult>, AppError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let ytdlp_path = ytdlp::find_ytdlp();

    // Run YouTube and SoundCloud searches in parallel
    let yt_fut = async {
        match ytdlp_path {
            Some(ref path) => discover::yt_search_tracks(path, &query, 5).await,
            None => Vec::new(),
        }
    };

    let sc_fut = async {
        let client_id = match discover::resolve_sc_client_id().await {
            Some(id) => id,
            None => return Vec::new(),
        };
        discover::sc_search_tracks(&client_id, &query, 5).await
    };

    let (yt_results, sc_results) = tokio::join!(yt_fut, sc_fut);

    // Merge results: YouTube first, then SoundCloud
    let mut all = yt_results;
    let yt_titles: std::collections::HashSet<String> = all
        .iter()
        .map(|r| normalize_for_dedup(&r.title))
        .collect();

    // Skip SC results whose normalized title is a substring match of a YT result
    for sc in sc_results {
        let norm = normalize_for_dedup(&sc.title);
        let is_dupe = yt_titles.iter().any(|yt| {
            yt.contains(&norm) || norm.contains(yt.as_str())
        });
        if !is_dupe {
            all.push(sc);
        }
    }

    // Cap total results
    all.truncate(10);
    Ok(all)
}

/// Normalize a title for deduplication: lowercase, strip parenthesized/bracketed
/// suffixes (e.g. "(Official Video)"), and collapse whitespace.
fn normalize_for_dedup(title: &str) -> String {
    let lower = title.to_lowercase();
    // Strip (…) and […] at the end
    let stripped = lower
        .trim_end()
        .trim_end_matches(|c: char| c == ')' || c == ']');
    let stripped = if let Some(pos) = stripped.rfind(|c: char| c == '(' || c == '[') {
        &stripped[..pos]
    } else {
        stripped
    };
    stripped
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Download a search result to the preview directory for inline playback.
/// Unlike discover_preview, this takes a direct URL instead of searching.
///
/// Called from JS: invoke("search_preview", { id, url, title })
#[tauri::command]
async fn search_preview(
    app: tauri::AppHandle,
    id: String,
    url: String,
    title: String,
) -> Result<(), AppError> {
    let preview_dir = discover::preview_dir(&app)?;
    let output_dir = preview_dir.to_string_lossy().to_string();

    tauri::async_runtime::spawn(async move {
        let ytdlp_path = match ytdlp::ensure_ytdlp(&app).await {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit(
                    "search-preview-status",
                    ytdlp::DownloadStatusEvent {
                        id: id.clone(),
                        status: "error".into(),
                        progress: 0.0,
                        message: format!("yt-dlp not available: {}", e),
                        backend: "ytdlp".into(),
                        title: Some(title),
                        file_path: None,
                        cover_art_base64: None,
                    },
                );
                return;
            }
        };

        match ytdlp::download_with_ytdlp(
            &ytdlp_path,
            &url,
            "mp3",
            &output_dir,
            &id,
            &app,
        )
        .await
        {
            Ok(result) => {
                let _ = app.emit(
                    "search-preview-status",
                    ytdlp::DownloadStatusEvent {
                        id: id.clone(),
                        status: "complete".into(),
                        progress: 100.0,
                        message: "Ready to preview".into(),
                        backend: "ytdlp".into(),
                        title: result.title.or(Some(title)),
                        file_path: result.file_path,
                        cover_art_base64: result.cover_art_base64,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "search-preview-status",
                    ytdlp::DownloadStatusEvent {
                        id: id.clone(),
                        status: "error".into(),
                        progress: 0.0,
                        message: format!("Preview failed: {}", e),
                        backend: "ytdlp".into(),
                        title: Some(title),
                        file_path: None,
                        cover_art_base64: None,
                    },
                );
            }
        }
    });

    Ok(())
}

// ========================================================================
// Discover Commands
// ========================================================================

/// Fetch similar tracks from multiple sources for the given seed tracks.
///
/// Called from JS: invoke("discover_similar", { seeds, lastfmApiKey })
#[tauri::command]
async fn discover_similar(
    seeds: Vec<discover::SeedTrack>,
    lastfm_api_key: String,
) -> Result<Vec<discover::SimilarTrack>, AppError> {
    if seeds.is_empty() || seeds.len() > 5 {
        return Err(AppError::LastFmFailed(
            "Provide 1-5 seed tracks".into(),
        ));
    }

    let ytdlp_path = ytdlp::find_ytdlp();

    let opts = discover::DiscoverOptions {
        lastfm_api_key,
        ytdlp_path,
    };

    discover::fetch_similar_for_seeds(&opts, &seeds, 30).await
}

/// Download a preview of a discovered track via yt-dlp search.
/// Downloads to the app's discover_previews directory.
///
/// Called from JS: invoke("discover_preview", { id, title, artist })
#[tauri::command]
async fn discover_preview(
    app: tauri::AppHandle,
    id: String,
    title: String,
    artist: String,
) -> Result<(), AppError> {
    let preview_dir = discover::preview_dir(&app)?;
    let output_dir = preview_dir.to_string_lossy().to_string();

    // Build a YouTube search query
    let search_query = format!("ytsearch1:{} - {}", artist, title);

    tauri::async_runtime::spawn(async move {
        // Ensure yt-dlp is available
        let ytdlp_path = match ytdlp::ensure_ytdlp(&app).await {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit(
                    "discover-status",
                    ytdlp::DownloadStatusEvent {
                        id: id.clone(),
                        status: "error".into(),
                        progress: 0.0,
                        message: format!("yt-dlp not available: {}", e),
                        backend: "ytdlp".into(),
                        title: Some(title),
                        file_path: None,
                        cover_art_base64: None,
                    },
                );
                return;
            }
        };

        match ytdlp::download_with_ytdlp(
            &ytdlp_path,
            &search_query,
            "mp3",
            &output_dir,
            &id,
            &app,
        )
        .await
        {
            Ok(result) => {
                // Re-emit as discover-status so the discover UI picks it up
                let _ = app.emit(
                    "discover-status",
                    ytdlp::DownloadStatusEvent {
                        id: id.clone(),
                        status: "complete".into(),
                        progress: 100.0,
                        message: "Ready to preview".into(),
                        backend: "ytdlp".into(),
                        title: result.title.or(Some(title)),
                        file_path: result.file_path,
                        cover_art_base64: result.cover_art_base64,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "discover-status",
                    ytdlp::DownloadStatusEvent {
                        id: id.clone(),
                        status: "error".into(),
                        progress: 0.0,
                        message: format!("Download failed: {}", e),
                        backend: "ytdlp".into(),
                        title: Some(title),
                        file_path: None,
                        cover_art_base64: None,
                    },
                );
            }
        }
    });

    Ok(())
}

/// Move a preview file to the user's output directory (keep it).
/// Returns the new file path.
///
/// Called from JS: invoke("discover_keep", { id, sourcePath })
#[tauri::command]
async fn discover_keep(
    app: tauri::AppHandle,
    id: String,
    source_path: String,
) -> Result<String, AppError> {
    let source = std::path::PathBuf::from(&source_path);
    if !source.exists() {
        return Err(AppError::Io(format!("Preview file not found: {}", source_path)));
    }

    let output_dir = get_store_value(&app, "outputDir")
        .unwrap_or_else(|| default_output_dir());

    let filename = source
        .file_name()
        .ok_or_else(|| AppError::Io("Invalid file path".into()))?;
    let dest = std::path::PathBuf::from(&output_dir).join(filename);
    let dest_str = dest.to_string_lossy().to_string();

    tokio::fs::rename(&source, &dest)
        .await
        .map_err(|e| AppError::Io(format!("Failed to move file: {}", e)))?;

    // Save to download history so it shows up in the Downloads tab
    let title = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let db = app.state::<Database>();
    let record = DownloadRecord {
        id,
        url: String::new(),
        format: "mp3".to_string(),
        status: "complete".to_string(),
        title,
        artist: String::new(),
        album: String::new(),
        cover_art_path: String::new(),
        file_path: dest_str.clone(),
        backend: "discover".to_string(),
        message: "Kept from Discover".to_string(),
        playlist_title: String::new(),
        created_at: database::now_timestamp(),
        cover_art_base64: String::new(),
    };
    if let Err(e) = db.insert_or_update(&record) {
        eprintln!("Failed to save discover keep record: {}", e);
    }

    Ok(dest_str)
}

/// Delete a single preview file.
///
/// Called from JS: invoke("discover_trash", { filePath })
#[tauri::command]
async fn discover_trash(file_path: String) -> Result<(), AppError> {
    let path = std::path::PathBuf::from(&file_path);
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| AppError::Io(format!("Failed to delete preview: {}", e)))?;
    }
    Ok(())
}

/// Delete all preview files.
///
/// Called from JS: invoke("discover_cleanup")
#[tauri::command]
async fn discover_cleanup(app: tauri::AppHandle) -> Result<(), AppError> {
    discover::cleanup_previews(&app)
}

// ========================================================================
// Playlist Commands
// ========================================================================

/// Extract playlist entries from a URL using yt-dlp --flat-playlist.
#[tauri::command]
async fn extract_playlist(
    app: tauri::AppHandle,
    url: String,
) -> Result<ytdlp::PlaylistInfo, AppError> {
    let ytdlp_path = ytdlp::ensure_ytdlp(&app).await?;
    ytdlp::extract_playlist(&ytdlp_path, &url).await
}

// ========================================================================
// Library Commands
// ========================================================================

/// List library folders the user has added.
#[tauri::command]
async fn get_library_folders(app: tauri::AppHandle) -> Result<Vec<String>, AppError> {
    let db = app.state::<Database>();
    db.list_library_folders().map_err(|e| AppError::Io(e.to_string()))
}

/// Add a folder to the library (does not scan).
#[tauri::command]
async fn add_library_folder(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.add_library_folder(&path).map_err(|e| AppError::Io(e.to_string()))
}

/// Remove a folder + all its cached tracks.
#[tauri::command]
async fn remove_library_folder(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.remove_library_folder(&path).map_err(|e| AppError::Io(e.to_string()))
}

/// Load all cached library tracks (fast — no disk walk).
#[tauri::command]
async fn get_library_tracks(app: tauri::AppHandle) -> Result<Vec<library::LibraryTrack>, AppError> {
    let db = app.state::<Database>();
    db.get_all_library_tracks().map_err(|e| AppError::Io(e.to_string()))
}

/// Apply MusicBrainz metadata to a library track. Writes ID3 tags, downloads
/// cover art, renames the file, and updates the library row in place.
#[tauri::command]
async fn apply_library_metadata(
    app: tauri::AppHandle,
    path: String,
    title: String,
    artist: String,
    album: String,
    release_mbid: String,
) -> Result<metadata::AppliedMetadata, AppError> {
    let rate_limiter = app.state::<RateLimiter>();
    let result = metadata::apply_metadata_to_file(
        &path,
        &title,
        &artist,
        &album,
        &release_mbid,
        &rate_limiter,
    )
    .await?;

    // Persist into library_tracks: keep first_scanned_at, refresh everything else.
    let cover_bytes = result.cover_art_base64.as_ref().and_then(|b64| {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(b64).ok()
    });

    let db = app.state::<Database>();
    db.update_library_track_after_edit(
        &path,
        &result.new_file_path,
        &result.title,
        &result.artist,
        &result.album,
        cover_bytes.as_deref(),
    )
    .map_err(|e| AppError::Io(e.to_string()))?;

    Ok(result)
}

/// Manually edit a library track's tags (no MusicBrainz). Mirrors update_mp3_metadata
/// but targets a library row by path. Returns the (possibly renamed) new path.
#[tauri::command]
async fn update_library_track(
    app: tauri::AppHandle,
    path: String,
    title: String,
    artist: String,
    album: String,
    new_filename: String,
) -> Result<String, AppError> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(AppError::Io(format!("File not found: {}", path)));
    }

    let mut tag = id3::Tag::read_from_path(&file_path).unwrap_or_else(|_| id3::Tag::new());
    if !title.is_empty() { tag.set_title(&title); }
    if !artist.is_empty() { tag.set_artist(&artist); }
    if !album.is_empty() { tag.set_album(&album); }
    tag.write_to_path(&file_path, id3::Version::Id3v24)
        .map_err(|e| AppError::Io(format!("Failed to write ID3 tags: {}", e)))?;

    let current_filename = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    // Auto-rename to "{Artist} - {Title}.{ext}" using the original extension.
    // The frontend ignores `new_filename` (it's a read-only display); we keep
    // the param in the signature for back-compat but only honor it when the
    // user explicitly differs from the auto-name.
    let _ = new_filename; // intentionally unused
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let target_filename = if !artist.is_empty() && !title.is_empty() {
        let stem = format!("{} - {}", sanitize_filename(&artist), sanitize_filename(&title));
        if ext.is_empty() { stem } else { format!("{}.{}", stem, ext) }
    } else {
        current_filename.clone()
    };

    let final_path = if target_filename != current_filename {
        let new_path = file_path.with_file_name(&target_filename);
        tokio::fs::rename(&file_path, &new_path)
            .await
            .map_err(|e| AppError::Io(format!("Failed to rename file: {}", e)))?;
        new_path.to_string_lossy().to_string()
    } else {
        path.clone()
    };

    // Re-read cover art (may have been changed externally) for the cache.
    let cover_bytes = id3::Tag::read_from_path(&final_path)
        .ok()
        .and_then(|t| t.pictures().next().map(|p| p.data.clone()));

    let db = app.state::<Database>();
    db.update_library_track_after_edit(
        &path,
        &final_path,
        &title,
        &artist,
        &album,
        cover_bytes.as_deref(),
    )
    .map_err(|e| AppError::Io(e.to_string()))?;

    Ok(final_path)
}

/// Increment the play counter and timestamp for a library track. Called from
/// the frontend when an audio element fires its natural `ended` event.
#[tauri::command]
async fn record_track_play(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.record_library_play(&path).map_err(|e| AppError::Io(e.to_string()))
}

/// Get a cached waveform for the given file path, computing + caching it
/// the first time it's requested. Returns 500 bytes of 0..=255 amplitude.
#[tauri::command]
async fn get_or_compute_waveform(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<u8>, AppError> {
    {
        let db = app.state::<Database>();
        if let Some(cached) = db
            .get_library_waveform(&path)
            .map_err(|e| AppError::Io(e.to_string()))?
        {
            if cached.len() == waveform::BUCKETS {
                return Ok(cached);
            }
        }
    }

    let computed = waveform::compute(std::path::Path::new(&path)).await?;
    let db = app.state::<Database>();
    db.set_library_waveform(&path, &computed)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(computed)
}

/// Try to find cover art for a library track. Pass `allow_youtube_search=false`
/// for the silent bulk pass (only trustworthy sources). Returns `None` if
/// nothing was found. Does NOT embed — call `embed_cover_art` to commit.
#[tauri::command]
async fn find_cover_candidate(
    app: tauri::AppHandle,
    path: String,
    title: String,
    artist: String,
    allow_youtube_search: bool,
) -> Result<Option<cover_art::CoverCandidate>, AppError> {
    let ytdlp_path = ytdlp::find_ytdlp();
    let db = app.state::<Database>();
    let candidate = cover_art::find_candidate(
        &path,
        &title,
        &artist,
        allow_youtube_search,
        &db,
        ytdlp_path.as_deref(),
    )
    .await;
    Ok(candidate)
}

/// Embed the given JPEG (base64) into the file's APIC frame and refresh the
/// library cache row.
#[tauri::command]
async fn embed_cover_art(
    app: tauri::AppHandle,
    path: String,
    image_base64: String,
) -> Result<(), AppError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_base64)
        .map_err(|e| AppError::Io(format!("Invalid base64: {}", e)))?;
    let db = app.state::<Database>();
    cover_art::embed_cover_into_file(&path, &bytes, &db)
}

/// Incremental scan of one folder: diff against cache, upsert changes, delete missing.
/// Returns counts of added/updated/removed/unchanged tracks.
#[tauri::command]
async fn scan_library_incremental(
    app: tauri::AppHandle,
    path: String,
) -> Result<library::ScanResult, AppError> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(AppError::Io(format!("Not a directory: {}", path)));
    }
    let app_clone = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let db = app_clone.state::<Database>();
        library::scan_folder_incremental(&dir, &db)
    })
    .await
    .map_err(|e| AppError::Io(format!("Scan failed: {}", e)))?;
    Ok(result)
}

/// Get the remote-control token + port for external controllers (e.g. Stream Deck).
#[tauri::command]
async fn get_remote_info(app: tauri::AppHandle) -> Result<serde_json::Value, AppError> {
    let token = get_store_value(&app, "remoteToken").unwrap_or_default();
    Ok(serde_json::json!({
        "token": token,
        "port": remote::REMOTE_PORT,
    }))
}

/// Read cover art from a single audio file, returned as base64.
#[tauri::command]
async fn get_track_cover_art(path: String) -> Result<String, AppError> {
    let file_path = std::path::PathBuf::from(&path);
    if let Ok(tag) = id3::Tag::read_from_path(&file_path) {
        if let Some(pic) = tag.pictures().next() {
            use base64::Engine;
            return Ok(base64::engine::general_purpose::STANDARD.encode(&pic.data));
        }
    }
    Ok(String::new())
}

// ========================================================================
// Playlist CRUD Commands
// ========================================================================

#[tauri::command]
async fn create_playlist(app: tauri::AppHandle, name: String) -> Result<database::PlaylistRow, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = app.state::<Database>();
    db.create_playlist(&id, &name)?;
    let playlists = db.list_playlists()?;
    playlists.into_iter().find(|p| p.id == id)
        .ok_or_else(|| AppError::Io("Failed to create playlist".into()))
}

#[tauri::command]
async fn rename_playlist(app: tauri::AppHandle, id: String, name: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.rename_playlist(&id, &name)?;
    Ok(())
}

#[tauri::command]
async fn delete_playlist(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.delete_playlist(&id)?;
    Ok(())
}

#[tauri::command]
async fn list_playlists(app: tauri::AppHandle) -> Result<Vec<database::PlaylistRow>, AppError> {
    let db = app.state::<Database>();
    Ok(db.list_playlists()?)
}

#[tauri::command]
async fn get_playlist_tracks(app: tauri::AppHandle, playlist_id: String) -> Result<Vec<library::LibraryTrack>, AppError> {
    let db = app.state::<Database>();
    let paths = db.get_playlist_track_paths(&playlist_id)?;
    let all_tracks = db.get_all_library_tracks()?;
    // Build a lookup and return tracks in playlist order
    let track_map: std::collections::HashMap<&str, &library::LibraryTrack> = all_tracks.iter()
        .map(|t| (t.path.as_str(), t))
        .collect();
    let result: Vec<library::LibraryTrack> = paths.iter()
        .filter_map(|p| track_map.get(p.as_str()).map(|t| (*t).clone()))
        .collect();
    Ok(result)
}

#[tauri::command]
async fn add_to_playlist(app: tauri::AppHandle, playlist_id: String, paths: Vec<String>) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.add_tracks_to_playlist(&playlist_id, &paths)?;
    Ok(())
}

#[tauri::command]
async fn remove_from_playlist(app: tauri::AppHandle, playlist_id: String, track_path: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.remove_track_from_playlist(&playlist_id, &track_path)?;
    Ok(())
}

#[tauri::command]
async fn reorder_playlist(app: tauri::AppHandle, playlist_id: String, paths: Vec<String>) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.reorder_playlist_tracks(&playlist_id, &paths)?;
    Ok(())
}

// ========================================================================
// Tag Commands
// ========================================================================

#[tauri::command]
async fn fetch_track_tags(
    app: tauri::AppHandle,
    path: String,
    title: String,
    artist: String,
) -> Result<Vec<(String, i32)>, AppError> {
    let api_key = get_store_value(&app, "lastfmApiKey").unwrap_or_default();
    if api_key.is_empty() {
        return Err(AppError::LastFmFailed("Last.fm API key not configured".into()));
    }
    let rate_limiter = app.state::<tags::TagRateLimiter>();
    let result = tags::fetch_tags_for_track(&api_key, &artist, &title, &rate_limiter).await?;
    let db = app.state::<Database>();
    db.set_track_tags(&path, &result)?;
    Ok(result)
}

#[tauri::command]
async fn bulk_fetch_tags(app: tauri::AppHandle) -> Result<(), AppError> {
    let api_key = get_store_value(&app, "lastfmApiKey").unwrap_or_default();
    if api_key.is_empty() {
        return Err(AppError::LastFmFailed("Last.fm API key not configured".into()));
    }

    tauri::async_runtime::spawn(async move {
        let db = app.state::<Database>();
        let rate_limiter = app.state::<tags::TagRateLimiter>();

        // Count total tracks needing fetch for progress
        let total = db.tracks_needing_tag_fetch(999999)
            .map(|v| v.len())
            .unwrap_or(0);

        let mut done = 0u32;
        loop {
            let batch = match db.tracks_needing_tag_fetch(20) {
                Ok(b) if b.is_empty() => break,
                Ok(b) => b,
                Err(_) => break,
            };

            for (path, title, artist) in &batch {
                match tags::fetch_tags_for_track(&api_key, artist, title, &rate_limiter).await {
                    Ok(tags) => {
                        let _ = db.set_track_tags(path, &tags);
                    }
                    Err(_) => {
                        // Mark as fetched even on failure to avoid retrying forever
                        let _ = db.set_track_tags(path, &[]);
                    }
                }
                done += 1;
                let _ = app.emit("tag-fetch-progress", serde_json::json!({
                    "done": done,
                    "total": total,
                }));
            }
        }

        let _ = app.emit("tag-fetch-progress", serde_json::json!({
            "done": done,
            "total": done,
            "finished": true,
        }));
    });

    Ok(())
}

#[tauri::command]
async fn get_all_tags(app: tauri::AppHandle) -> Result<Vec<(i64, String, i64)>, AppError> {
    let db = app.state::<Database>();
    Ok(db.get_all_tags()?)
}

#[tauri::command]
async fn get_tracks_for_tag(app: tauri::AppHandle, tag_name: String) -> Result<Vec<String>, AppError> {
    let db = app.state::<Database>();
    let conn = db.get_all_tags()?; // reuse to find tag id
    let tag_id = conn.iter().find(|(_, name, _)| name == &tag_name).map(|(id, _, _)| *id);
    match tag_id {
        Some(_) => {
            // Use a direct query approach
            let all_track_tags = db.get_all_track_tags()?;
            let paths: Vec<String> = all_track_tags.into_iter()
                .filter(|(_, tags)| tags.contains(&tag_name))
                .map(|(path, _)| path)
                .collect();
            Ok(paths)
        }
        None => Ok(Vec::new()),
    }
}

// ========================================================================
// Feed / Subscription Commands
// ========================================================================

/// Resolve a YouTube channel URL/handle and subscribe. Fetches initial uploads.
#[tauri::command]
async fn add_subscription(app: tauri::AppHandle, url: String) -> Result<database::Subscription, AppError> {
    let ytdlp_path = ytdlp::ensure_ytdlp(&app).await?;

    // Resolve channel info: fetch 1 video to get channel metadata
    let output = tokio::process::Command::new(&ytdlp_path)
        .args(["--flat-playlist", "-J", "--no-warnings", "--playlist-end", "1", &url])
        .output()
        .await
        .map_err(|e| AppError::YtDlpFailed(format!("Failed to resolve channel: {}", e)))?;

    if !output.status.success() {
        return Err(AppError::YtDlpFailed("Could not resolve channel URL".into()));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::YtDlpFailed(format!("Invalid JSON: {}", e)))?;

    let channel_id = json["channel_id"]
        .as_str()
        .or_else(|| json["id"].as_str())
        .ok_or_else(|| AppError::YtDlpFailed("No channel ID found".into()))?
        .to_string();

    let channel_name = json["channel"]
        .as_str()
        .or_else(|| json["uploader"].as_str())
        .or_else(|| json["title"].as_str())
        .unwrap_or("Unknown Channel")
        .to_string();

    let channel_url = json["channel_url"]
        .as_str()
        .or_else(|| json["uploader_url"].as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| url.clone());

    let thumbnail = json["thumbnails"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|t| t["url"].as_str())
        .unwrap_or("")
        .to_string();

    let db = app.state::<Database>();
    db.add_subscription(&channel_id, &channel_name, &channel_url, &thumbnail)?;

    // Fetch initial batch of uploads in background
    let app2 = app.clone();
    let cid = channel_id.clone();
    let curl = channel_url.clone();
    tauri::async_runtime::spawn(async move {
        let _ = fetch_channel_uploads(&app2, &ytdlp_path, &cid, &curl, 15).await;
    });

    Ok(database::Subscription {
        id: channel_id,
        name: channel_name,
        url: channel_url,
        thumbnail,
        added_at: database::now_unix(),
    })
}

#[tauri::command]
async fn remove_subscription(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let db = app.state::<Database>();
    db.remove_subscription(&id)?;
    Ok(())
}

#[tauri::command]
async fn list_subscriptions(app: tauri::AppHandle) -> Result<Vec<database::Subscription>, AppError> {
    let db = app.state::<Database>();
    Ok(db.list_subscriptions()?)
}

#[tauri::command]
async fn refresh_feed(app: tauri::AppHandle) -> Result<(), AppError> {
    let ytdlp_path = ytdlp::ensure_ytdlp(&app).await?;
    let db = app.state::<Database>();
    let subs = db.list_subscriptions()?;

    let total = subs.len();
    let app2 = app.clone();

    tauri::async_runtime::spawn(async move {
        for (i, sub) in subs.iter().enumerate() {
            let _ = fetch_channel_uploads(&app2, &ytdlp_path, &sub.id, &sub.url, 15).await;
            let _ = app2.emit("feed-refresh-progress", serde_json::json!({
                "done": i + 1,
                "total": total,
            }));
        }
        let _ = app2.emit("feed-refresh-progress", serde_json::json!({
            "done": total,
            "total": total,
            "finished": true,
        }));
    });

    Ok(())
}

#[tauri::command]
async fn get_feed(app: tauri::AppHandle) -> Result<Vec<database::FeedItem>, AppError> {
    let db = app.state::<Database>();
    Ok(db.get_feed_items(200)?)
}

/// Fetch latest uploads from a single channel and store them.
async fn fetch_channel_uploads(
    app: &tauri::AppHandle,
    ytdlp_path: &std::path::Path,
    channel_id: &str,
    channel_url: &str,
    limit: u32,
) -> Result<(), AppError> {
    let videos_url = if channel_url.ends_with("/videos") {
        channel_url.to_string()
    } else {
        format!("{}/videos", channel_url.trim_end_matches('/'))
    };

    // Use -j (full metadata per video) instead of --flat-playlist so we get
    // upload_date for proper chronological sorting.
    let output = tokio::process::Command::new(ytdlp_path)
        .args([
            "--no-download", "-j", "--no-warnings",
            "--playlist-end", &limit.to_string(),
            &videos_url,
        ])
        .output()
        .await
        .map_err(|e| AppError::YtDlpFailed(format!("Failed to fetch uploads: {}", e)))?;

    if !output.status.success() {
        return Err(AppError::YtDlpFailed("Failed to fetch channel uploads".into()));
    }

    // -j outputs one JSON object per line
    let stdout = String::from_utf8_lossy(&output.stdout);
    let items: Vec<database::FeedItem> = stdout
        .lines()
        .filter_map(|line| {
            let entry: serde_json::Value = serde_json::from_str(line).ok()?;
            let video_id = entry["id"].as_str()?.to_string();
            let title = entry["title"].as_str()?.to_string();
            let uploader = entry["uploader"]
                .as_str()
                .or_else(|| entry["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();
            let duration = entry["duration"].as_f64().unwrap_or(0.0) as u32;
            let thumbnail = entry["thumbnails"]
                .as_array()
                .and_then(|arr| arr.last())
                .and_then(|t| t["url"].as_str())
                .or_else(|| entry["thumbnail"].as_str())
                .unwrap_or("")
                .to_string();
            let upload_date = entry["upload_date"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let url = format!("https://www.youtube.com/watch?v={}", video_id);

            Some(database::FeedItem {
                video_id,
                channel_id: channel_id.to_string(),
                title,
                uploader,
                duration,
                thumbnail,
                upload_date,
                url,
            })
        })
        .collect();

    let db = app.state::<Database>();
    db.upsert_feed_items(&items)?;
    Ok(())
}

// ========================================================================
// Helper functions
// ========================================================================

/// Read a string value from the persistent store.
/// Returns None if the key doesn't exist or isn't a string.
fn get_store_value(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let store = app.store("settings.json").ok()?;
    store.get(key).and_then(|v| v.as_str().map(|s| s.to_string()))
}

/// Get the default output directory (user's Downloads folder).
/// Falls back to the home directory if Downloads doesn't exist.
fn default_output_dir() -> String {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// Default music library directory (~/Music or home).
fn default_music_dir() -> String {
    dirs::audio_dir()
        .or_else(dirs::home_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

/// Probe a media file's duration in seconds using ffprobe (sibling of ffmpeg).
/// Returns None if ffprobe isn't found or parsing fails — callers should handle gracefully.
async fn probe_duration(ffmpeg_path: &std::path::Path, input: &str) -> Option<f64> {
    // ffprobe lives next to ffmpeg; try sibling first, then PATH
    let ffprobe = ffmpeg_path
        .parent()
        .map(|dir| dir.join("ffprobe"))
        .filter(|p| p.exists())
        .or_else(|| which::which("ffprobe").ok())?;

    let output = tokio::process::Command::new(ffprobe)
        .args([
            "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            input,
        ])
        .output()
        .await
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.trim().parse::<f64>().ok()
}

/// Replace characters that are invalid in filenames with underscores.
fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect()
}

// ========================================================================
// App entry point
// ========================================================================

/// Build and run the Tauri application.
/// This is called from main.rs and sets up all plugins and commands.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Custom URI scheme for serving audio files with permissive CORS so
        // Web Audio's MediaElementSource (used by the spectrogram) can read
        // their data. The default `asset:` protocol is treated as cross-origin
        // and silently zeroes analyser output.
        .register_uri_scheme_protocol("wjaudio", |_app, request| {
            use std::io::{Read, Seek, SeekFrom};
            use tauri::http::{header, Response, StatusCode};

            // wjaudio://localhost/<percent-encoded-absolute-path>
            let uri = request.uri().to_string();
            let after_host = uri
                .splitn(2, "://")
                .nth(1)
                .and_then(|rest| rest.splitn(2, '/').nth(1))
                .unwrap_or("");
            let decoded = urlencoding::decode(after_host)
                .map(|s| s.into_owned())
                .unwrap_or_default();

            let mime = match std::path::Path::new(&decoded)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "mp3" => "audio/mpeg",
                "flac" => "audio/flac",
                "ogg" | "opus" => "audio/ogg",
                "m4a" | "aac" => "audio/mp4",
                "wav" => "audio/wav",
                "webm" => "audio/webm",
                _ => "application/octet-stream",
            };

            // Parse a single-range "Range: bytes=START-END" header (the only
            // form Chromium uses for media seeks). Multi-range is rare here
            // and we ignore it (return the whole file).
            let range_header = request
                .headers()
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("bytes="))
                .and_then(|s| {
                    let mut parts = s.splitn(2, '-');
                    let start = parts.next()?.parse::<u64>().ok()?;
                    let end = parts.next().and_then(|e| e.parse::<u64>().ok());
                    Some((start, end))
                });

            let mut file = match std::fs::File::open(&decoded) {
                Ok(f) => f,
                Err(e) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(format!("File not found: {} ({})", decoded, e).into_bytes())
                        .unwrap();
                }
            };
            let total_len = file.metadata().map(|m| m.len()).unwrap_or(0);

            let common = |b: tauri::http::response::Builder| {
                b.header(header::CONTENT_TYPE, mime)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET")
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(header::CACHE_CONTROL, "no-cache")
            };

            if let Some((start, end_opt)) = range_header {
                let end = end_opt.unwrap_or(total_len.saturating_sub(1)).min(total_len.saturating_sub(1));
                if start > end || start >= total_len {
                    return common(Response::builder())
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{}", total_len))
                        .body(Vec::new())
                        .unwrap();
                }
                let length = end - start + 1;
                let mut buf = vec![0u8; length as usize];
                if file.seek(SeekFrom::Start(start)).is_err()
                    || file.read_exact(&mut buf).is_err()
                {
                    return common(Response::builder())
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(b"read failed".to_vec())
                        .unwrap();
                }
                return common(Response::builder())
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, total_len))
                    .header(header::CONTENT_LENGTH, length.to_string())
                    .body(buf)
                    .unwrap();
            }

            // No Range header — return the whole file.
            let mut bytes = Vec::with_capacity(total_len as usize);
            if file.read_to_end(&mut bytes).is_err() {
                return common(Response::builder())
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .body(b"read failed".to_vec())
                    .unwrap();
            }
            common(Response::builder())
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, bytes.len().to_string())
                .body(bytes)
                .unwrap()
        })
        // Register plugins:
        // - shell: for opening URLs in the system browser
        // - dialog: for the folder picker in settings
        // - store: for persisting settings to disk
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Initialize the database and store it in managed state
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");
            let db = Database::new(&app_data_dir)
                .expect("Failed to initialize download history database");
            app.manage(db);
            app.manage(RateLimiter::new());
            app.manage(tags::TagRateLimiter::new());

            // Load or generate the remote-control token, then launch the HTTP server.
            let token = {
                let store = app
                    .store("settings.json")
                    .expect("Failed to open settings store");
                let existing = store
                    .get("remoteToken")
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                match existing {
                    Some(t) if !t.is_empty() => t,
                    _ => {
                        use rand::Rng;
                        let t: String = rand::rng()
                            .sample_iter(&rand::distr::Alphanumeric)
                            .take(32)
                            .map(char::from)
                            .collect();
                        store.set("remoteToken", serde_json::Value::String(t.clone()));
                        let _ = store.save();
                        t
                    }
                }
            };
            remote::spawn(app.handle().clone(), token);

            Ok(())
        })
        // Register our command handlers — these become available to JS via invoke()
        .invoke_handler(tauri::generate_handler![
            start_download,
            ensure_ytdlp_ready,
            get_settings,
            set_setting,
            open_file,
            reveal_file,
            update_mp3_metadata,
            get_download_history,
            remove_download_history,
            clear_download_history,
            fetch_metadata,
            apply_metadata,
            extract_audio,
            search_sources,
            search_preview,
            discover_similar,
            discover_preview,
            discover_keep,
            discover_trash,
            discover_cleanup,
            extract_playlist,
            get_library_folders,
            add_library_folder,
            remove_library_folder,
            get_library_tracks,
            scan_library_incremental,
            apply_library_metadata,
            update_library_track,
            find_cover_candidate,
            embed_cover_art,
            get_or_compute_waveform,
            record_track_play,
            get_track_cover_art,
            get_remote_info,
            create_playlist,
            rename_playlist,
            delete_playlist,
            list_playlists,
            get_playlist_tracks,
            add_to_playlist,
            remove_from_playlist,
            reorder_playlist,
            fetch_track_tags,
            bulk_fetch_tags,
            get_all_tags,
            get_tracks_for_tag,
            add_subscription,
            remove_subscription,
            list_subscriptions,
            refresh_feed,
            get_feed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

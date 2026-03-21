// lib.rs — The main Tauri plugin/command registration file.
// This is where we:
//   1. Define all the #[tauri::command] functions (the bridge between Rust and JS)
//   2. Register plugins (store, dialog, shell)
//   3. Build and run the Tauri app
//
// Each command function is async so it doesn't block the main thread.
// Tauri automatically handles serialization/deserialization of arguments and return values.

mod cobalt;
mod database;
mod downloader;
mod error;
mod metadata;
mod ytdlp;

use database::{Database, DownloadRecord};
use error::AppError;
use id3::TagLike;
use metadata::RateLimiter;
use tauri::Manager;
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
) -> Result<(), AppError> {
    // Read settings from the persistent store
    let output_dir = get_store_value(&app, "outputDir")
        .unwrap_or_else(|| default_output_dir());
    let cobalt_url = get_store_value(&app, "cobaltUrl")
        .unwrap_or_default();

    let pl_title = playlist_title.unwrap_or_default();

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
        .unwrap_or_else(|| default_output_dir());
    let cobalt_url = get_store_value(&app, "cobaltUrl")
        .unwrap_or_default();
    let format = get_store_value(&app, "format")
        .unwrap_or_else(|| "mp3".to_string());
    let player_volume = get_store_value(&app, "playerVolume");

    Ok(serde_json::json!({
        "outputDir": output_dir,
        "cobaltUrl": cobalt_url,
        "format": format,
        "playerVolume": player_volume,
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
            extract_playlist,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

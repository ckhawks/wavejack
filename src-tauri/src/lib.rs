// lib.rs — The main Tauri plugin/command registration file.
// This is where we:
//   1. Define all the #[tauri::command] functions (the bridge between Rust and JS)
//   2. Register plugins (store, dialog, shell)
//   3. Build and run the Tauri app
//
// Each command function is async so it doesn't block the main thread.
// Tauri automatically handles serialization/deserialization of arguments and return values.

mod cobalt;
mod downloader;
mod error;
mod ytdlp;

use error::AppError;
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
) -> Result<(), AppError> {
    // Read settings from the persistent store
    let output_dir = get_store_value(&app, "outputDir")
        .unwrap_or_else(|| default_output_dir());
    let cobalt_url = get_store_value(&app, "cobaltUrl")
        .unwrap_or_default();

    // Spawn the download as a background task.
    // We use tauri::async_runtime::spawn so it runs independently.
    // This means start_download returns immediately while the download continues.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = downloader::download(
            &app,
            &id,
            &url,
            &format,
            &output_dir,
            &cobalt_url,
        )
        .await
        {
            eprintln!("Download failed for {}: {}", url, e);
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
        .unwrap_or_else(|| "mp4".to_string());

    Ok(serde_json::json!({
        "outputDir": output_dir,
        "cobaltUrl": cobalt_url,
        "format": format,
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
        // Register our command handlers — these become available to JS via invoke()
        .invoke_handler(tauri::generate_handler![
            start_download,
            ensure_ytdlp_ready,
            get_settings,
            set_setting,
            open_file,
            reveal_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

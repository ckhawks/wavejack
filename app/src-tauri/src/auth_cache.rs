// auth_cache.rs — Tiny file-backed JSON cache for OAuth tokens.
//
// Spotify and Tidal both persist a `{access, refresh, expires_at, ...}` blob
// to {app_data_dir}/<file>.json. The shape differs (Tidal carries user_id +
// country_code, Spotify doesn't) so the cached struct stays per-module — but
// the I/O wrapping is identical and lives here.

use crate::error::AppError;
use serde::{de::DeserializeOwned, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn token_path(app: &AppHandle, file: &str) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Settings(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(file))
}

pub fn load<T: DeserializeOwned>(app: &AppHandle, file: &str) -> Option<T> {
    let path = token_path(app, file).ok()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn save<T: Serialize>(app: &AppHandle, file: &str, token: &T) -> Result<(), AppError> {
    let path = token_path(app, file)?;
    std::fs::write(
        path,
        serde_json::to_string(token).map_err(|e| AppError::Settings(e.to_string()))?,
    )?;
    Ok(())
}

pub fn clear(app: &AppHandle, file: &str) -> Result<(), AppError> {
    let path = token_path(app, file)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

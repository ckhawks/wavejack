// error.rs — Centralized error type for the entire app.
// We derive Serialize so errors can be sent over Tauri's IPC bridge to the frontend.
// thiserror gives us nice Display impls automatically from the #[error("...")] attributes.

use serde::Serialize;
use thiserror::Error;

/// Every error that can happen in our backend.
/// Each variant maps to a different failure mode so the frontend can show useful messages.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")] // produces JSON like { "kind": "YtDlpNotFound", "message": "..." }
pub enum AppError {
    /// yt-dlp binary couldn't be found on PATH or in our app data directory
    #[error("yt-dlp not found: {0}")]
    YtDlpNotFound(String),

    /// yt-dlp ran but exited with an error (bad URL, network issue, etc.)
    #[error("yt-dlp failed: {0}")]
    YtDlpFailed(String),

    /// The cobalt.tools API request failed
    #[error("Cobalt failed: {0}")]
    CobaltFailed(String),

    /// Both yt-dlp AND cobalt failed — nothing worked
    #[error("All backends failed. yt-dlp: {ytdlp_err} | Cobalt: {cobalt_err}")]
    AllBackendsFailed {
        ytdlp_err: String,
        cobalt_err: String,
    },

    /// The URL the user entered doesn't look valid
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    /// Generic I/O error (file write failed, etc.)
    #[error("IO error: {0}")]
    Io(String),

    /// Settings read/write failure
    #[error("Settings error: {0}")]
    Settings(String),
}

// Convert std::io::Error into our AppError automatically.
// This lets us use the `?` operator on any I/O call.
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

// Convert reqwest errors (HTTP client) into our AppError.
impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

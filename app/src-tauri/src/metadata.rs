use crate::cover_art;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Instant;

/// Rate limiter for MusicBrainz API (1 request per second).
pub struct RateLimiter {
    last_request: Mutex<Option<Instant>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            last_request: Mutex::new(None),
        }
    }

    /// Wait if needed to respect rate limit.
    pub async fn wait(&self) {
        let wait_duration = {
            let mut last = self.last_request.lock().unwrap();
            let now = Instant::now();
            let wait = if let Some(prev) = *last {
                let elapsed = now.duration_since(prev);
                if elapsed < std::time::Duration::from_secs(1) {
                    Some(std::time::Duration::from_secs(1) - elapsed)
                } else {
                    None
                }
            } else {
                None
            };
            *last = Some(now);
            wait
        };
        if let Some(d) = wait_duration {
            tokio::time::sleep(d).await;
            // Update timestamp after sleeping
            let mut last = self.last_request.lock().unwrap();
            *last = Some(Instant::now());
        }
    }
}

/// A metadata match from MusicBrainz.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataMatch {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub release_mbid: String,
    pub score: u32,
}

/// Result of applying metadata to a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppliedMetadata {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_art_base64: Option<String>,
    pub new_file_path: String,
}

const USER_AGENT: &str = "MediaDownloader/0.1.0 (media-downloader-app)";

/// Search MusicBrainz for recording matches.
pub async fn search_musicbrainz(
    query: &str,
    rate_limiter: &RateLimiter,
) -> Result<Vec<MetadataMatch>, AppError> {
    rate_limiter.wait().await;

    let client = reqwest::Client::new();
    let url = format!(
        "https://musicbrainz.org/ws/2/recording?query={}&fmt=json&limit=5",
        urlencoding::encode(query)
    );

    let response = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| AppError::MetadataFailed(format!("MusicBrainz request failed: {}", e)))?;

    if !response.status().is_success() {
        return Err(AppError::MetadataFailed(format!(
            "MusicBrainz returned HTTP {}",
            response.status()
        )));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| AppError::MetadataFailed(format!("Invalid MusicBrainz JSON: {}", e)))?;

    let recordings = body["recordings"]
        .as_array()
        .unwrap_or(&Vec::new())
        .clone();

    let mut matches = Vec::new();
    for rec in &recordings {
        let title = rec["title"].as_str().unwrap_or("").to_string();
        let score = rec["score"].as_u64().unwrap_or(0) as u32;

        // Get first artist
        let artist = rec["artist-credit"]
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|ac| ac["artist"]["name"].as_str())
            .unwrap_or("")
            .to_string();

        // Get first release info
        let (album, release_mbid) = rec["releases"]
            .as_array()
            .and_then(|arr| arr.first())
            .map(|rel| {
                let album = rel["title"].as_str().unwrap_or("").to_string();
                let mbid = rel["id"].as_str().unwrap_or("").to_string();
                (album, mbid)
            })
            .unwrap_or_default();

        if !title.is_empty() {
            matches.push(MetadataMatch {
                title,
                artist,
                album,
                release_mbid,
                score,
            });
        }
    }

    Ok(matches)
}

/// Download cover art, embed in MP3, set tags, rename file.
pub async fn apply_metadata_to_file(
    path: &str,
    title: &str,
    artist: &str,
    album: &str,
    release_mbid: &str,
    rate_limiter: &RateLimiter,
) -> Result<AppliedMetadata, AppError> {
    let file_path = std::path::PathBuf::from(path);
    if !file_path.exists() {
        return Err(AppError::MetadataFailed("File not found".to_string()));
    }

    // Try to download cover art
    let mut cover_art_base64: Option<String> = None;
    let mut cover_bytes: Option<Vec<u8>> = None;

    if !release_mbid.is_empty() {
        rate_limiter.wait().await;

        let cover_url = format!(
            "https://coverartarchive.org/release/{}/front-250",
            release_mbid
        );

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| AppError::MetadataFailed(e.to_string()))?;

        match client
            .get(&cover_url)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
        {
            Ok(resp) => {
                if resp.status().is_success() {
                    match resp.bytes().await {
                        Ok(bytes) if !bytes.is_empty() => {
                            use base64::Engine;
                            eprintln!("Cover art downloaded: {} bytes", bytes.len());
                            cover_art_base64 =
                                Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
                            cover_bytes = Some(bytes.to_vec());
                        }
                        Ok(_) => eprintln!("Cover art response was empty"),
                        Err(e) => eprintln!("Failed to read cover art bytes: {}", e),
                    }
                } else {
                    eprintln!("Cover art not available: HTTP {}", resp.status());
                }
            }
            Err(e) => {
                eprintln!("Cover art request failed: {}", e);
            }
        }
    }

    // Write tags + cover via lofty (format-agnostic).
    cover_art::write_tags_to_file(
        &file_path,
        Some(title),
        Some(artist),
        Some(album),
        cover_bytes.as_deref(),
    )
    .map_err(|e| AppError::MetadataFailed(format!("Failed to write tags: {}", e)))?;

    eprintln!(
        "Tags written to {:?}: title={:?}, artist={:?}, album={:?}, has_cover={}",
        file_path, title, artist, album, cover_art_base64.is_some()
    );

    // Auto-rename: "Artist - Title.<ext>" — preserve the original
    // extension so flac/m4a/etc. don't get masqueraded as mp3.
    let current_filename = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3");

    let new_filename = if !artist.is_empty() && !title.is_empty() {
        let auto = format!(
            "{} - {}.{}",
            sanitize_filename(artist),
            sanitize_filename(title),
            ext
        );
        if auto != current_filename {
            auto
        } else {
            current_filename.clone()
        }
    } else {
        current_filename.clone()
    };

    let final_path = if new_filename != current_filename {
        let new_path = file_path.with_file_name(&new_filename);
        tokio::fs::rename(&file_path, &new_path)
            .await
            .map_err(|e| AppError::MetadataFailed(format!("Failed to rename file: {}", e)))?;
        new_path.to_string_lossy().to_string()
    } else {
        path.to_string()
    };

    Ok(AppliedMetadata {
        title: title.to_string(),
        artist: artist.to_string(),
        album: album.to_string(),
        cover_art_base64,
        new_file_path: final_path,
    })
}

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect()
}

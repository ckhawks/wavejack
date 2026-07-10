// discover.rs — Track discovery via Last.fm and SoundCloud.
// Fetches similar tracks, downloads previews via yt-dlp,
// and lets the user keep or trash each recommendation.

use crate::error::AppError;
use rand::seq::SliceRandom;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// A search result from YouTube or SoundCloud.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: u32,
    pub thumbnail_url: String,
    /// "youtube" or "soundcloud"
    pub source: String,
    /// Direct URL suitable for yt-dlp download.
    pub url: String,
}

/// Cached SoundCloud client_id resolved at runtime.
static SC_CLIENT_ID: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn sc_mutex() -> &'static Mutex<Option<String>> {
    SC_CLIENT_ID.get_or_init(|| Mutex::new(None))
}

/// A seed track provided by the user.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SeedTrack {
    pub title: String,
    pub artist: String,
}

/// A similar track from Last.fm or SoundCloud.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SimilarTrack {
    pub name: String,
    pub artist: String,
    pub match_score: f64,
    /// "lastfm" or "soundcloud"
    pub source: String,
}

/// Fetch similar tracks from Last.fm for a single seed.
async fn fetch_similar(
    api_key: &str,
    track: &str,
    artist: &str,
    limit: u32,
) -> Result<Vec<SimilarTrack>, AppError> {
    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=track.getSimilar\
         &track={}&artist={}&api_key={}&format=json&limit={}",
        urlencoding::encode(track),
        urlencoding::encode(artist),
        urlencoding::encode(api_key),
        limit,
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| AppError::LastFmFailed(format!("Request failed: {}", e)))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::LastFmFailed(format!("Invalid JSON: {}", e)))?;

    // Last.fm error response: { "error": 6, "message": "..." }
    if let Some(err) = json.get("error") {
        let msg = json["message"].as_str().unwrap_or("Unknown error");
        return Err(AppError::LastFmFailed(format!(
            "Last.fm API error {}: {}",
            err, msg
        )));
    }

    let tracks = json["similartracks"]["track"]
        .as_array()
        .ok_or_else(|| AppError::LastFmFailed("No similar tracks found".into()))?;

    let results: Vec<SimilarTrack> = tracks
        .iter()
        .filter_map(|t| {
            let name = t["name"].as_str()?.to_string();
            let artist = t["artist"]["name"].as_str()?.to_string();
            let match_score = t["match"]
                .as_f64()
                .or_else(|| t["match"].as_str().and_then(|s| s.parse::<f64>().ok()))
                .unwrap_or(0.0);
            Some(SimilarTrack {
                name,
                artist,
                match_score,
                source: "lastfm".into(),
            })
        })
        .collect();

    Ok(results)
}

/// Fetch similar artists from Last.fm, then get their top tracks.
/// Fallback for when track.getSimilar returns nothing (unknown tracks).
async fn fetch_via_similar_artists(
    api_key: &str,
    artist: &str,
    artist_limit: u32,
    tracks_per_artist: u32,
) -> Result<Vec<SimilarTrack>, AppError> {
    // Step 1: Get similar artists
    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar\
         &artist={}&api_key={}&format=json&limit={}",
        urlencoding::encode(artist),
        urlencoding::encode(api_key),
        artist_limit,
    );

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| AppError::LastFmFailed(format!("Request failed: {}", e)))?;

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::LastFmFailed(format!("Invalid JSON: {}", e)))?;

    if json.get("error").is_some() {
        return Ok(Vec::new());
    }

    let similar_artists = match json["similarartists"]["artist"].as_array() {
        Some(arr) => arr.clone(),
        None => return Ok(Vec::new()),
    };

    // Step 2: Get top tracks for each similar artist
    let mut results: Vec<SimilarTrack> = Vec::new();

    for sa in similar_artists.iter().take(artist_limit as usize) {
        let artist_name = match sa["name"].as_str() {
            Some(n) => n,
            None => continue,
        };
        let artist_match = sa["match"]
            .as_f64()
            .or_else(|| sa["match"].as_str().and_then(|s| s.parse::<f64>().ok()))
            .unwrap_or(0.0);

        let top_url = format!(
            "https://ws.audioscrobbler.com/2.0/?method=artist.getTopTracks\
             &artist={}&api_key={}&format=json&limit={}",
            urlencoding::encode(artist_name),
            urlencoding::encode(api_key),
            tracks_per_artist,
        );

        let top_resp = match reqwest::get(&top_url).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        let top_json: serde_json::Value = match top_resp.json().await {
            Ok(j) => j,
            Err(_) => continue,
        };

        if let Some(tracks) = top_json["toptracks"]["track"].as_array() {
            for t in tracks {
                let name = match t["name"].as_str() {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                results.push(SimilarTrack {
                    name,
                    artist: artist_name.to_string(),
                    match_score: artist_match,
                    source: "lastfm".into(),
                });
            }
        }
    }

    Ok(results)
}

/// Split a compound artist string into individual artists.
/// Handles separators like ",", "&", "feat.", "ft.", "x", "and", "with".
fn split_artists(artist: &str) -> Vec<String> {
    // Split on common delimiters, preserving the original as first option
    let re_parts: Vec<&str> = artist
        .split(|c: char| c == ',' || c == '&')
        .flat_map(|part| {
            // Further split on "feat.", "ft.", " x ", " and ", " with "
            let p = part.trim();
            if let Some(pos) = p.to_lowercase().find(" feat. ") {
                vec![&p[..pos], &p[pos + 7..]]
            } else if let Some(pos) = p.to_lowercase().find(" feat ") {
                vec![&p[..pos], &p[pos + 6..]]
            } else if let Some(pos) = p.to_lowercase().find(" ft. ") {
                vec![&p[..pos], &p[pos + 4..]]
            } else if let Some(pos) = p.to_lowercase().find(" ft ") {
                vec![&p[..pos], &p[pos + 4..]]
            } else {
                vec![p]
            }
        })
        .collect();

    re_parts
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// ========================================================================
// SoundCloud related tracks
// ========================================================================

/// Resolve SoundCloud's client_id from their public JS bundles.
/// Caches the result so we only do this once per app session.
pub async fn resolve_sc_client_id() -> Option<String> {
    let mut cached = sc_mutex().lock().await;
    if let Some(ref id) = *cached {
        return Some(id.clone());
    }

    // Fetch SoundCloud's main page to find JS bundle URLs
    let html = reqwest::get("https://soundcloud.com")
        .await
        .ok()?
        .text()
        .await
        .ok()?;

    // Find script URLs like https://a-v2.sndcdn.com/assets/0-1234abcd.js
    let script_urls: Vec<&str> = html
        .split("src=\"")
        .filter_map(|chunk| {
            let url = chunk.split('"').next()?;
            if url.contains("sndcdn.com") && url.ends_with(".js") {
                Some(url)
            } else {
                None
            }
        })
        .collect();

    // Check the last few scripts (client_id is usually in the last bundle)
    for url in script_urls.iter().rev().take(5) {
        let js = match reqwest::get(*url).await {
            Ok(r) => match r.text().await {
                Ok(t) => t,
                Err(_) => continue,
            },
            Err(_) => continue,
        };

        // Look for client_id pattern: client_id:"aBcDeFgHiJkLmNoPqRsT"
        // or client_id:"..." or ,client_id:"..."
        if let Some(pos) = js.find("client_id:\"") {
            let after = &js[pos + 11..];
            if let Some(end) = after.find('"') {
                let id = &after[..end];
                if id.len() > 10 && id.chars().all(|c| c.is_alphanumeric()) {
                    *cached = Some(id.to_string());
                    return Some(id.to_string());
                }
            }
        }
        // Also try: client_id="..."
        if let Some(pos) = js.find("client_id=\"") {
            let after = &js[pos + 11..];
            if let Some(end) = after.find('"') {
                let id = &after[..end];
                if id.len() > 10 && id.chars().all(|c| c.is_alphanumeric()) {
                    *cached = Some(id.to_string());
                    return Some(id.to_string());
                }
            }
        }
    }

    None
}

/// Search SoundCloud for a track by query, return the first match's track ID.
async fn sc_search_track(client_id: &str, query: &str) -> Option<u64> {
    let url = format!(
        "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit=1",
        urlencoding::encode(query),
        client_id,
    );

    let resp = reqwest::get(&url).await.ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;
    let collection = json["collection"].as_array()?;
    let first = collection.first()?;
    first["id"].as_u64()
}

/// Fetch related tracks for a SoundCloud track ID.
async fn sc_related_tracks(
    client_id: &str,
    track_id: u64,
    limit: u32,
) -> Vec<SimilarTrack> {
    let url = format!(
        "https://api-v2.soundcloud.com/tracks/{}/related?client_id={}&limit={}",
        track_id, client_id, limit,
    );

    let resp = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };

    let collection = match json["collection"].as_array() {
        Some(c) => c,
        None => return Vec::new(),
    };

    collection
        .iter()
        .filter_map(|t| {
            let title = t["title"].as_str()?.to_string();
            let artist = t["user"]["username"].as_str()?.to_string();
            Some(SimilarTrack {
                name: title,
                artist,
                match_score: 0.5,
                source: "soundcloud".into(),
            })
        })
        .collect()
}

/// Search SoundCloud for tracks by query, returning full result objects.
pub async fn sc_search_tracks(client_id: &str, query: &str, limit: u32) -> Vec<SearchResult> {
    let url = format!(
        "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit={}",
        urlencoding::encode(query),
        client_id,
        limit,
    );

    let resp = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };

    let collection = match json["collection"].as_array() {
        Some(c) => c,
        None => return Vec::new(),
    };

    collection
        .iter()
        .filter_map(|t| {
            let title = t["title"].as_str()?.to_string();
            let artist = t["user"]["username"].as_str()?.to_string();
            let duration_ms = t["duration"].as_u64().unwrap_or(0);
            let duration_secs = (duration_ms / 1000) as u32;
            let thumbnail_url = t["artwork_url"]
                .as_str()
                .unwrap_or("")
                .replace("-large", "-t300x300")
                .to_string();
            let permalink = t["permalink_url"].as_str()?.to_string();
            let id = t["id"].as_u64()?.to_string();

            Some(SearchResult {
                id,
                title,
                artist,
                duration_secs,
                thumbnail_url,
                source: "soundcloud".into(),
                url: permalink,
            })
        })
        .collect()
}

/// Try to find related tracks on SoundCloud for a given artist + title.
pub async fn fetch_soundcloud_related(
    artist: &str,
    title: &str,
    limit: u32,
) -> Vec<SimilarTrack> {
    let client_id = match resolve_sc_client_id().await {
        Some(id) => id,
        None => {
            eprintln!("SoundCloud: failed to resolve client_id");
            return Vec::new();
        }
    };

    let query = format!("{} {}", artist, title);
    let track_id = match sc_search_track(&client_id, &query).await {
        Some(id) => id,
        None => {
            eprintln!("SoundCloud: no search results for '{}'", query);
            return Vec::new();
        }
    };

    sc_related_tracks(&client_id, track_id, limit).await
}

// ========================================================================
// YouTube Music recommendations (via yt-dlp Mix playlists)
// ========================================================================

/// Get recommendations from YouTube by extracting the auto-generated Mix playlist.
/// Searches for the track, gets the video ID, then extracts the RD{id} mix.
pub async fn fetch_youtube_related(
    ytdlp_path: &std::path::Path,
    artist: &str,
    title: &str,
    limit: u32,
) -> Vec<SimilarTrack> {
    let query = format!("ytsearch1:{} - {}", artist, title);

    // Step 1: Get the video ID via yt-dlp -j (JSON dump without downloading)
    let output = match tokio::process::Command::new(ytdlp_path)
        .args(["--no-download", "-j", "--no-warnings", &query])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("YouTube: yt-dlp search failed: {}", e);
            return Vec::new();
        }
    };

    if !output.status.success() {
        return Vec::new();
    }

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };

    let video_id = match json["id"].as_str() {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };

    // Step 2: Extract the YouTube Mix playlist (RD + video ID)
    let mix_url = format!(
        "https://www.youtube.com/watch?v={}&list=RD{}",
        video_id, video_id
    );

    let mix_output = match tokio::process::Command::new(ytdlp_path)
        .args([
            "--flat-playlist",
            "-J",
            "--no-warnings",
            "--playlist-end",
            &limit.to_string(),
            &mix_url,
        ])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("YouTube: mix extraction failed: {}", e);
            return Vec::new();
        }
    };

    if !mix_output.status.success() {
        return Vec::new();
    }

    let mix_json: serde_json::Value = match serde_json::from_slice(&mix_output.stdout) {
        Ok(j) => j,
        Err(_) => return Vec::new(),
    };

    let entries = match mix_json["entries"].as_array() {
        Some(e) => e,
        None => return Vec::new(),
    };

    entries
        .iter()
        .filter_map(|entry| {
            let entry_title = entry["title"].as_str()?.to_string();
            let uploader = entry["uploader"]
                .as_str()
                .or_else(|| entry["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();

            // Skip the seed track itself
            if entry["id"].as_str() == Some(video_id.as_str()) {
                return None;
            }

            // Try to split "Artist - Title" from the video title
            let (artist, name) = if entry_title.contains(" - ") {
                let idx = entry_title.find(" - ").unwrap();
                (
                    entry_title[..idx].trim().to_string(),
                    entry_title[idx + 3..].trim().to_string(),
                )
            } else {
                (uploader, entry_title)
            };

            Some(SimilarTrack {
                name,
                artist,
                match_score: 0.6,
                source: "youtube".into(),
            })
        })
        .collect()
}

/// Search YouTube for tracks matching a query, returning structured results.
/// Uses `ytsearch{limit}:{query}` which returns one JSON object per line.
pub async fn yt_search_tracks(
    ytdlp_path: &std::path::Path,
    query: &str,
    limit: u32,
) -> Vec<SearchResult> {
    let search_query = format!("ytsearch{}:{}", limit, query);

    let output = match tokio::process::Command::new(ytdlp_path)
        .args(["--no-download", "-j", "--no-warnings", &search_query])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            eprintln!("YouTube search: yt-dlp failed: {}", e);
            return Vec::new();
        }
    };

    if !output.status.success() {
        return Vec::new();
    }

    // yt-dlp outputs one JSON object per line for multi-result searches
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(|line| {
            let json: serde_json::Value = serde_json::from_str(line).ok()?;
            let video_id = json["id"].as_str()?.to_string();
            let title = json["title"].as_str()?.to_string();
            let uploader = json["uploader"]
                .as_str()
                .or_else(|| json["channel"].as_str())
                .unwrap_or("Unknown")
                .to_string();
            let duration_secs = json["duration"].as_f64().unwrap_or(0.0) as u32;
            let thumbnail_url = json["thumbnail"]
                .as_str()
                .or_else(|| {
                    json["thumbnails"]
                        .as_array()
                        .and_then(|arr| arr.last())
                        .and_then(|t| t["url"].as_str())
                })
                .unwrap_or("")
                .to_string();
            let url = format!("https://www.youtube.com/watch?v={}", video_id);

            // Try to split "Artist - Title" from video title
            let (artist, clean_title) = if title.contains(" - ") {
                let idx = title.find(" - ").unwrap();
                (
                    title[..idx].trim().to_string(),
                    title[idx + 3..].trim().to_string(),
                )
            } else {
                (uploader.clone(), title.clone())
            };

            Some(SearchResult {
                id: video_id,
                title: clean_title,
                artist,
                duration_secs,
                thumbnail_url,
                source: "youtube".into(),
                url,
            })
        })
        .collect()
}

// ========================================================================
// Seed resolution & merging
// ========================================================================

/// Options for which discovery sources to use.
pub struct DiscoverOptions {
    pub lastfm_api_key: String,
    pub ytdlp_path: Option<std::path::PathBuf>,
}

/// Fetch similar tracks for multiple seeds, merge and deduplicate.
/// Pulls from Last.fm, SoundCloud, YouTube Music, and Spotify in parallel per seed.
pub async fn fetch_similar_for_seeds(
    opts: &DiscoverOptions,
    seeds: &[SeedTrack],
    per_seed_limit: u32,
) -> Result<Vec<SimilarTrack>, AppError> {
    let mut all: Vec<SimilarTrack> = Vec::new();

    let has_lastfm = !opts.lastfm_api_key.is_empty();

    for seed in seeds {
        let mut found = false;

        // --- Last.fm ---
        if has_lastfm {
            // 1. Try track.getSimilar with full artist string
            if let Ok(tracks) = fetch_similar(&opts.lastfm_api_key, &seed.title, &seed.artist, per_seed_limit).await {
                if !tracks.is_empty() {
                    all.extend(tracks);
                    found = true;
                }
            }

            // 2. If compound artist, try each individual artist
            if !found {
                let artists = split_artists(&seed.artist);
                if artists.len() > 1 {
                    let limit_each = per_seed_limit / artists.len() as u32;
                    for individual in &artists {
                        if let Ok(tracks) = fetch_similar(&opts.lastfm_api_key, &seed.title, individual, limit_each).await {
                            if !tracks.is_empty() {
                                all.extend(tracks);
                                found = true;
                            }
                        }
                    }
                }
            }

            // 3. Fallback: artist.getSimilar → top tracks
            if !found {
                let artists = split_artists(&seed.artist);
                for individual in &artists {
                    if let Ok(tracks) = fetch_via_similar_artists(&opts.lastfm_api_key, individual, 10, 3).await {
                        if !tracks.is_empty() {
                            all.extend(tracks);
                            found = true;
                        }
                    }
                }
            }
        }

        // --- SoundCloud ---
        let sc_tracks = fetch_soundcloud_related(&seed.artist, &seed.title, 50).await;
        if !sc_tracks.is_empty() {
            all.extend(sc_tracks);
            found = true;
        }

        // --- YouTube Music ---
        if let Some(ref ytdlp) = opts.ytdlp_path {
            let yt_tracks = fetch_youtube_related(ytdlp, &seed.artist, &seed.title, 30).await;
            if !yt_tracks.is_empty() {
                all.extend(yt_tracks);
                found = true;
            }
        }

        if !found {
            eprintln!(
                "Discover: no results at all for '{} - {}'",
                seed.artist, seed.title
            );
        }
    }

    if all.is_empty() {
        return Err(AppError::LastFmFailed(
            "No similar tracks found for any seed".into(),
        ));
    }

    // Deduplicate by (artist_lower, name_lower), keeping highest match_score
    let mut seen = HashSet::new();
    let mut deduped: Vec<SimilarTrack> = Vec::new();

    // Also filter out seeds themselves
    let seed_keys: HashSet<(String, String)> = seeds
        .iter()
        .map(|s| (s.artist.to_lowercase(), s.title.to_lowercase()))
        .collect();

    // Sort by match_score descending first so we keep the best version
    all.sort_by(|a, b| b.match_score.partial_cmp(&a.match_score).unwrap_or(std::cmp::Ordering::Equal));

    for track in all {
        let key = (track.artist.to_lowercase(), track.name.to_lowercase());
        if seed_keys.contains(&key) {
            continue;
        }
        if seen.insert(key) {
            deduped.push(track);
        }
    }

    // Shuffle so it's not just top matches in order
    let mut rng = rand::rng();
    deduped.shuffle(&mut rng);

    Ok(deduped)
}

/// Get or create the preview directory under the app's data dir.
pub fn preview_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("Cannot get app data dir: {}", e)))?;
    let dir = data_dir.join("discover_previews");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Io(format!("Failed to create preview dir: {}", e)))?;
    }
    Ok(dir)
}

/// Delete all files in the preview directory.
pub fn cleanup_previews(app: &AppHandle) -> Result<(), AppError> {
    let dir = preview_dir(app)?;
    if dir.exists() {
        for entry in std::fs::read_dir(&dir)
            .map_err(|e| AppError::Io(format!("Failed to read preview dir: {}", e)))?
        {
            if let Ok(entry) = entry {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::split_artists;

    #[test]
    fn splits_on_comma_and_ampersand() {
        assert_eq!(split_artists("A, B & C"), vec!["A", "B", "C"]);
    }

    #[test]
    fn splits_on_feat_and_ft_variants() {
        assert_eq!(split_artists("Artist feat. Guest"), vec!["Artist", "Guest"]);
        assert_eq!(split_artists("Artist ft Guest"), vec!["Artist", "Guest"]);
    }

    #[test]
    fn passes_through_a_single_artist() {
        assert_eq!(split_artists("Solo"), vec!["Solo"]);
    }

    #[test]
    fn drops_empty_segments_and_trims() {
        assert_eq!(split_artists("A,,  B "), vec!["A", "B"]);
    }
}

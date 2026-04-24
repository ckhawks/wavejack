use base64::Engine;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

use crate::database::Database;

#[derive(Debug, Clone, Serialize)]
pub struct LibraryTrack {
    pub path: String,
    pub filename: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u32,
    /// Base64-encoded cover art. Empty when the track has no embedded art.
    /// Stored as raw BLOB in SQLite; serialized as base64 for the frontend.
    pub cover_art_base64: String,
    /// Unix seconds when this track first appeared in the library cache.
    /// Defaults to 0 in the constructor; the DB layer fills it on read.
    #[serde(default)]
    pub first_scanned_at: i64,
    /// Approximate average bitrate in kbps. Computed by the DB layer on upsert
    /// from file size + duration; left at 0 by the metadata reader itself.
    #[serde(default)]
    pub bitrate_kbps: u32,
    /// True when bitrate_kbps was derived from size/duration rather than read
    /// from audio frame headers — treat as a rough estimate in the UI.
    #[serde(default)]
    pub bitrate_estimated: bool,
    /// How many times this track has finished playing (Last.fm-style: only
    /// natural ends count, not skips).
    #[serde(default)]
    pub play_count: u32,
    /// Unix seconds of the most recent natural finish, or 0 if never.
    #[serde(default)]
    pub last_played_at: i64,
    /// Top tags from Last.fm, populated by bulk load from track_tags table.
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct ScanResult {
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub unchanged: u32,
}

/// Walk `folder` once, reconciling the on-disk state with the library_tracks
/// cache in the given database. Returns counts of what changed.
pub fn scan_folder_incremental(folder: &Path, db: &Database) -> ScanResult {
    let folder_str = folder.to_string_lossy().to_string();

    // Build fingerprint map from cache: path -> (mtime, size)
    let cache = db
        .library_tracks_fingerprint(&folder_str)
        .unwrap_or_default();
    // path -> (mtime, size, duration_secs, bitrate_kbps, bitrate_estimated)
    let cache_map: HashMap<String, (i64, i64, i64, i64, bool)> = cache
        .into_iter()
        .map(|(p, m, s, d, b, e)| (p, (m, s, d, b, e)))
        .collect();

    let mut seen_paths: Vec<String> = Vec::with_capacity(cache_map.len());
    let mut result = ScanResult::default();

    walk(folder, &folder_str, &cache_map, &mut seen_paths, &mut result, db);

    // Anything in cache that we didn't see on disk gets deleted.
    let seen_set: std::collections::HashSet<&String> = seen_paths.iter().collect();
    let missing: Vec<String> = cache_map
        .keys()
        .filter(|p| !seen_set.contains(*p))
        .cloned()
        .collect();
    result.removed = missing.len() as u32;
    let _ = db.delete_library_tracks(&missing);

    result
}

fn walk(
    dir: &Path,
    folder_root: &str,
    cache: &HashMap<String, (i64, i64, i64, i64, bool)>,
    seen: &mut Vec<String>,
    result: &mut ScanResult,
    db: &Database,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, folder_root, cache, seen, result, db);
            continue;
        }
        if !is_audio_file(&path) {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;

        seen.push(path_str.clone());

        match cache.get(&path_str) {
            // Skip only if mtime+size match AND duration+bitrate are populated
            // AND the bitrate was read by lofty (not a size/duration estimate).
            // A 0 in either, or an estimated bitrate, signals a row that needs
            // re-reading through the lofty parser.
            Some(&(m, s, d, b, est)) if m == mtime && s == size && d > 0 && b > 0 && !est => {
                result.unchanged += 1;
                continue;
            }
            Some(_) => result.updated += 1,
            None => result.added += 1,
        }

        if let Some((track, cover_bytes)) = read_track_metadata(&path) {
            let _ = db.upsert_library_track(
                folder_root,
                &track,
                mtime,
                size,
                cover_bytes.as_deref(),
            );
        }
    }
}

fn is_audio_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("mp3" | "flac" | "ogg" | "m4a" | "aac" | "wav" | "wma" | "opus")
    )
}

/// Shell out to ffprobe for duration + bitrate when lofty can't read them.
/// Needed for containers lofty doesn't grok — notably FLAC-in-MP4 (what
/// tidal-dl-ng produces for HI_RES_LOSSLESS tracks, `.m4a` extension but a
/// FLAC stream inside a QuickTime container). Returns (duration_secs,
/// bitrate_kbps); zeros mean ffprobe couldn't parse either.
fn ffprobe_duration_bitrate(path: &Path) -> (u32, u32) {
    let Some(ffprobe) = which::which("ffprobe").ok() else {
        return (0, 0);
    };
    let output = std::process::Command::new(ffprobe)
        .args([
            "-v", "error",
            "-show_entries", "format=duration,bit_rate",
            "-of", "default=nw=1:nk=1",
        ])
        .arg(path)
        .output();
    let Ok(out) = output else { return (0, 0) };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let duration_secs = lines
        .next()
        .and_then(|l| l.trim().parse::<f64>().ok())
        .map(|f| f as u32)
        .unwrap_or(0);
    let bitrate_kbps = lines
        .next()
        .and_then(|l| l.trim().parse::<u64>().ok())
        .map(|b| (b / 1000) as u32)
        .unwrap_or(0);
    (duration_secs, bitrate_kbps)
}

/// Read metadata and (separately) raw cover art bytes for DB storage.
/// Uses lofty for format-agnostic parsing (MP3/FLAC/OGG/M4A/...) and to read
/// the actual encoded bitrate from frame headers instead of approximating.
/// Falls back to ffprobe for containers lofty can't parse.
fn read_track_metadata(path: &Path) -> Option<(LibraryTrack, Option<Vec<u8>>)> {
    let filename = path.file_name()?.to_string_lossy().to_string();
    let path_str = path.to_string_lossy().to_string();

    if let Ok(probe) = Probe::open(path) {
        if let Ok(tagged) = probe.read() {
            let props = tagged.properties();
            let mut duration_secs = props.duration().as_secs() as u32;
            let mut bitrate_kbps = props.audio_bitrate().unwrap_or(0);
            // FLAC-in-MP4 and a few other containers return 0/0 from lofty
            // even though tags read fine. Fill the gap with ffprobe so the
            // library table doesn't just show dashes.
            if duration_secs == 0 || bitrate_kbps == 0 {
                let (d, b) = ffprobe_duration_bitrate(path);
                if duration_secs == 0 { duration_secs = d; }
                if bitrate_kbps == 0 { bitrate_kbps = b; }
            }

            let (title, artist, album, cover_bytes) = if let Some(tag) = tagged
                .primary_tag()
                .or_else(|| tagged.first_tag())
            {
                let title = tag.title().map(|s| s.to_string()).unwrap_or_default();
                let artist = tag.artist().map(|s| s.to_string()).unwrap_or_default();
                let album = tag.album().map(|s| s.to_string()).unwrap_or_default();
                let cover = tag.pictures().first().map(|p| p.data().to_vec());
                (title, artist, album, cover)
            } else {
                (String::new(), String::new(), String::new(), None)
            };

            let cover_b64 = cover_bytes
                .as_ref()
                .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
                .unwrap_or_default();

            return Some((
                LibraryTrack {
                    path: path_str,
                    filename: filename.clone(),
                    title: if title.is_empty() { stem_from_filename(&filename) } else { title },
                    artist,
                    album,
                    duration_secs,
                    cover_art_base64: cover_b64,
                    first_scanned_at: 0,
                    bitrate_kbps,
                    bitrate_estimated: false,
                    play_count: 0,
                    last_played_at: 0,
                    tags: Vec::new(),
                },
                cover_bytes,
            ));
        }
    }

    // lofty rejected the file entirely — still try ffprobe so we at least
    // surface duration + bitrate in the library table.
    let (duration_secs, bitrate_kbps) = ffprobe_duration_bitrate(path);
    Some((
        LibraryTrack {
            path: path_str,
            filename: filename.clone(),
            title: stem_from_filename(&filename),
            artist: String::new(),
            album: String::new(),
            duration_secs,
            cover_art_base64: String::new(),
            first_scanned_at: 0,
            bitrate_kbps,
            bitrate_estimated: false,
            play_count: 0,
            last_played_at: 0,
            tags: Vec::new(),
        },
        None,
    ))
}

fn stem_from_filename(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| filename.to_string())
}

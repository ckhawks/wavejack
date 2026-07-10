use base64::Engine;
use lofty::file::{AudioFile, FileType, TaggedFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::database::Database;

/// For a content-detected container type, return its (display label, canonical
/// extension, set of acceptable extensions). `None` for exotic/unknown types we
/// won't second-guess. The acceptable set matters because one container has
/// several valid extensions (e.g. an MP4 audio file may be .m4a or .mp4), so we
/// only flag a true mismatch — never rename .mp4→.m4a just to normalize.
fn type_info(ft: FileType) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    use FileType::*;
    Some(match ft {
        Mpeg => ("MP3", "mp3", &["mp3"]),
        Flac => ("FLAC", "flac", &["flac"]),
        // MP4 container — may hold AAC or (Tidal HI_RES) FLAC; the extension is
        // about the container, so .m4a/.mp4 are both correct.
        Mp4 => ("M4A", "m4a", &["m4a", "mp4", "m4b", "m4p"]),
        Opus => ("Opus", "opus", &["opus", "ogg"]),
        Vorbis => ("OGG", "ogg", &["ogg", "oga"]),
        Wav => ("WAV", "wav", &["wav", "wave"]),
        Aiff => ("AIFF", "aiff", &["aiff", "aif", "aifc"]),
        Aac => ("AAC", "aac", &["aac"]),
        Ape => ("APE", "ape", &["ape"]),
        WavPack => ("WavPack", "wv", &["wv"]),
        Speex => ("Speex", "spx", &["spx", "ogg"]),
        _ => return None,
    })
}

/// Read a file's tags using **content-based** type detection. `Probe::open`
/// alone trusts the filename extension, so a misnamed file (e.g. an AAC/MP4
/// stream saved as ".mp3") would be parsed as the wrong container — or misread.
/// `guess_file_type()` sniffs the actual magic bytes so we always work on the
/// true format. Returns `None` when lofty can't parse the file at all.
pub fn read_tagged(path: &Path) -> Option<TaggedFile> {
    Probe::open(path).ok()?.guess_file_type().ok()?.read().ok()
}

/// Read embedded (title, artist, album) from a file's primary tag. Empty
/// strings where a field is absent. Used to backfill download-history rows,
/// which are stored blank at download time even though the downloader (yt-dlp,
/// tidal-dl-ng) embeds these tags into the file itself.
pub fn read_basic_tags(path: &Path) -> (String, String, String) {
    let Some(tagged) = read_tagged(path) else {
        return (String::new(), String::new(), String::new());
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return (String::new(), String::new(), String::new());
    };
    (
        tag.title().map(|s| s.to_string()).unwrap_or_default(),
        tag.artist().map(|s| s.to_string()).unwrap_or_default(),
        tag.album().map(|s| s.to_string()).unwrap_or_default(),
    )
}

/// Human-readable label for the Library "Type" column. Reads the file's real
/// container via lofty; falls back to the (upper-cased) extension when lofty
/// can't parse it (e.g. WMA).
pub fn detect_type_label(path: &Path) -> String {
    if let Some(tf) = read_tagged(path) {
        if let Some((label, _, _)) = type_info(tf.file_type()) {
            return label.to_string();
        }
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_uppercase())
        .unwrap_or_default()
}

/// If `path`'s extension doesn't match its actual container, return the correct
/// extension. `None` means the extension is already valid or the file can't be
/// read / isn't a type we rename.
pub fn corrected_extension(path: &Path) -> Option<&'static str> {
    let tf = read_tagged(path)?;
    let (_, canonical, accepted) = type_info(tf.file_type())?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext {
        Some(e) if accepted.contains(&e.as_str()) => None,
        _ => Some(canonical),
    }
}

/// Rename `path` to its content-correct extension when mislabeled, without
/// clobbering an existing file. Returns (final path, whether it was renamed).
pub fn fix_extension(path: &Path) -> std::io::Result<(PathBuf, bool)> {
    let Some(correct) = corrected_extension(path) else {
        return Ok((path.to_path_buf(), false));
    };
    let target = path.with_extension(correct);
    if target == path {
        return Ok((path.to_path_buf(), false));
    }
    // Never overwrite an unrelated file already sitting at the target name.
    let target = non_clobbering_path(path, &target);
    std::fs::rename(path, &target)?;
    Ok((target, true))
}

/// Resolve `desired` to a path that will not clobber a *different* existing file.
///
/// Renaming `A.mp3` → `B.mp3` with `std::fs`/`tokio::fs` silently replaces an
/// existing `B.mp3`. When two tracks share an artist+title (e.g. a clean rip and
/// a live version), an edit/normalize of one would destroy the other. This appends
/// a ` (n)` suffix until a free name is found so the rename is always non-destructive.
///
/// If `desired` already exists but refers to the *same* file as `source` — a
/// case-only rename on a case-insensitive filesystem (Windows, default macOS APFS) —
/// `desired` is returned unchanged so we don't spuriously suffix it.
pub fn non_clobbering_path(source: &Path, desired: &Path) -> PathBuf {
    if !desired.exists() {
        return desired.to_path_buf();
    }
    // Same underlying file (case-only rename)? Allow it through untouched.
    if let (Ok(a), Ok(b)) = (
        std::fs::canonicalize(source),
        std::fs::canonicalize(desired),
    ) {
        if a == b {
            return desired.to_path_buf();
        }
    }
    let ext = desired.extension().and_then(|e| e.to_str());
    let stem = desired.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
    let dir = desired.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut n = 1;
    loop {
        let name = match ext {
            Some(e) => format!("{} ({}).{}", stem, n, e),
            None => format!("{} ({})", stem, n),
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

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
    /// Content-detected container type ("MP3", "M4A", "FLAC", ...). May differ
    /// from the filename's extension for mislabeled files.
    #[serde(default)]
    pub file_type: String,
}

/// One playback-start event joined to its library track, for the "Recent" view.
#[derive(Debug, Clone, Serialize)]
pub struct PlayHistoryEntry {
    /// play_history row id — a stable, unique key for the UI (a track can appear
    /// many times in the list).
    pub id: i64,
    /// Unix seconds when playback started.
    pub played_at: i64,
    /// The library track that was played.
    pub track: LibraryTrack,
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
    // path -> (mtime, size, duration_secs, bitrate_kbps, bitrate_estimated, file_type)
    let cache_map: HashMap<String, (i64, i64, i64, i64, bool, String)> = cache
        .into_iter()
        .map(|(p, m, s, d, b, e, ft)| (p, (m, s, d, b, e, ft)))
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
    cache: &HashMap<String, (i64, i64, i64, i64, bool, String)>,
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
            // AND the bitrate was read by lofty (not a size/duration estimate)
            // AND we already have a content-detected file_type. A 0 in either,
            // an estimated bitrate, or a blank file_type signals a row that
            // needs re-reading through the lofty parser.
            Some((m, s, d, b, est, ft))
                if *m == mtime && *s == size && *d > 0 && *b > 0 && !*est && !ft.is_empty() =>
            {
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

    if let Some(tagged) = read_tagged(path) {
        {
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
                    file_type: type_info(tagged.file_type())
                        .map(|(l, _, _)| l.to_string())
                        .unwrap_or_default(),
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
            // lofty couldn't parse it — best-effort label from the extension.
            file_type: path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_uppercase())
                .unwrap_or_default(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A unique, freshly-created temp dir per test (parallel-safe via distinct tags).
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wavejack_lib_test_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn returns_desired_when_target_is_free() {
        let dir = temp_dir("free");
        let src = dir.join("a.mp3");
        fs::write(&src, b"x").unwrap();
        let desired = dir.join("b.mp3");
        assert_eq!(non_clobbering_path(&src, &desired), desired);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn suffixes_rather_than_clobbering_a_different_file() {
        // The C1 data-loss scenario: a clean rip and a live version normalize to the
        // same "Artist - Title.mp3". Renaming one must NOT overwrite the other.
        let dir = temp_dir("clobber");
        let src = dir.join("live.mp3");
        fs::write(&src, b"live").unwrap();
        let desired = dir.join("Artist - Title.mp3");
        fs::write(&desired, b"clean").unwrap(); // a different file already sits here
        let got = non_clobbering_path(&src, &desired);
        assert_eq!(got, dir.join("Artist - Title (1).mp3"));
        assert_ne!(got, desired);
        // the pre-existing file is untouched
        assert_eq!(fs::read(&desired).unwrap(), b"clean");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn increments_suffix_until_free() {
        let dir = temp_dir("incr");
        let src = dir.join("src.mp3");
        fs::write(&src, b"s").unwrap();
        let desired = dir.join("t.mp3");
        fs::write(&desired, b"0").unwrap();
        fs::write(dir.join("t (1).mp3"), b"1").unwrap();
        assert_eq!(non_clobbering_path(&src, &desired), dir.join("t (2).mp3"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn allows_case_only_rename_of_the_same_file() {
        // On a case-insensitive FS (Windows/macOS) `desired` "exists" but is the same
        // underlying file — must pass through without a spurious "(1)" suffix. On a
        // case-sensitive FS `desired` simply doesn't exist, so it also passes through.
        let dir = temp_dir("case");
        let src = dir.join("artist - title.mp3");
        fs::write(&src, b"x").unwrap();
        let desired = dir.join("Artist - Title.mp3");
        assert_eq!(non_clobbering_path(&src, &desired), desired);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn suffixes_extensionless_targets() {
        let dir = temp_dir("noext");
        let src = dir.join("s");
        fs::write(&src, b"s").unwrap();
        let desired = dir.join("name");
        fs::write(&desired, b"0").unwrap();
        assert_eq!(non_clobbering_path(&src, &desired), dir.join("name (1)"));
        fs::remove_dir_all(&dir).unwrap();
    }
}

// cover_art.rs — Find & embed missing album art for library tracks.
//
// Three-step fallback per track:
//   1. MusicBrainz top-match (score ≥ 90 + artist contains check) → CoverArtArchive
//   2. yt-dlp thumbnail from the original source URL stored in the downloads table
//   3. yt-dlp ytsearch1 thumbnail (low-confidence — caller decides whether to embed)
//
// All returned images are JPEG, center-cropped to square. The caller embeds
// via `embed_cover_into_file` which writes an ID3 APIC frame and updates the
// library_tracks BLOB cache.

use crate::database::Database;
use crate::error::AppError;
use base64::Engine;
use image::ImageFormat;
use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, Tag, TagExt, TagType};
use serde::Serialize;
use std::io::Cursor;
use std::path::Path;

const USER_AGENT: &str = "Wavejack/0.1.0 (wavejack-app)";
const MIN_MB_SCORE: u32 = 90;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverSource {
    MusicBrainz,
    DownloadHistory,
    YoutubeSearch,
}

#[derive(Debug, Serialize)]
pub struct CoverCandidate {
    pub source: CoverSource,
    /// JPEG bytes, center-cropped to square, base64-encoded for the frontend.
    pub image_base64: String,
    /// Source URL when known (download history / YT search) — for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// Try to find a cover candidate for a track that has no embedded art.
///
/// `allow_youtube_search` controls whether step 3 (low-confidence ytsearch)
/// is attempted; bulk callers usually pass `false` for the auto pass.
pub async fn find_candidate(
    file_path: &str,
    title: &str,
    artist: &str,
    allow_youtube_search: bool,
    db: &Database,
    ytdlp_path: Option<&Path>,
) -> Option<CoverCandidate> {
    // Step 1: MusicBrainz (skip if we have nothing meaningful to query)
    if !title.is_empty() {
        if let Some(bytes) = try_musicbrainz(title, artist).await {
            if let Some(square) = crop_square_jpeg(&bytes) {
                return Some(CoverCandidate {
                    source: CoverSource::MusicBrainz,
                    image_base64: base64::engine::general_purpose::STANDARD.encode(&square),
                    source_url: None,
                });
            }
        }
    }

    // Step 2: source URL from download history
    if let Some(ytdlp) = ytdlp_path {
        if let Some(url) = db.find_download_url_for_path(file_path).ok().flatten() {
            if is_supported_source(&url) {
                if let Some((bytes, thumb_url)) = try_ytdlp_thumbnail(ytdlp, &url).await {
                    if let Some(square) = crop_square_jpeg(&bytes) {
                        return Some(CoverCandidate {
                            source: CoverSource::DownloadHistory,
                            image_base64: base64::engine::general_purpose::STANDARD.encode(&square),
                            source_url: Some(thumb_url.unwrap_or(url)),
                        });
                    }
                }
            }
        }
    }

    // Step 3: YouTube search (low confidence, only if allowed)
    if allow_youtube_search {
        if let Some(ytdlp) = ytdlp_path {
            let query = format!("ytsearch1:{} {}", artist, title);
            if let Some((bytes, thumb_url)) = try_ytdlp_thumbnail(ytdlp, &query).await {
                if let Some(square) = crop_square_jpeg(&bytes) {
                    return Some(CoverCandidate {
                        source: CoverSource::YoutubeSearch,
                        image_base64: base64::engine::general_purpose::STANDARD.encode(&square),
                        source_url: thumb_url,
                    });
                }
            }
        }
    }

    None
}

/// Embed JPEG bytes as cover art on an audio file and refresh the
/// library_tracks cache row. Format-agnostic: handles MP3 (ID3v2),
/// FLAC (Vorbis comments), M4A (MP4 atoms), and WAV/AIFF (ID3v2 chunks).
pub fn embed_cover_into_file(
    file_path: &str,
    jpeg_bytes: &[u8],
    db: &Database,
) -> Result<(), AppError> {
    let path = std::path::PathBuf::from(file_path);
    if !path.exists() {
        return Err(AppError::Io(format!("File not found: {}", file_path)));
    }

    write_cover_to_file(&path, jpeg_bytes)?;

    // Update the library cache row in place. We keep title/artist/album
    // intact and just refresh the cover BLOB + mtime/size so a rescan
    // doesn't immediately re-process this file.
    db.update_library_cover(file_path, jpeg_bytes)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// Pick the natural tag type for a given audio file extension. Lofty
/// supports all of these as the "primary" tag for the corresponding
/// container, so writes round-trip cleanly with players like Rekordbox
/// and Serato.
fn tag_type_for(path: &Path) -> TagType {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("flac") | Some("ogg") | Some("opus") => TagType::VorbisComments,
        Some("m4a") | Some("mp4") | Some("aac") => TagType::Mp4Ilst,
        // mp3, wav, aif, aiff, and unknown all carry ID3v2.
        _ => TagType::Id3v2,
    }
}

/// Write JPEG bytes as the front-cover picture on any supported audio
/// file via lofty. Preserves existing title/artist/album tags by editing
/// the file's primary tag in place rather than overwriting it.
pub fn write_cover_to_file(path: &Path, jpeg_bytes: &[u8]) -> Result<(), AppError> {
    let tag_type = tag_type_for(path);

    // Try to read existing tags so we don't clobber title/artist/album.
    // If the file has no tags yet (fresh download), start a new tag of
    // the correct type for the container.
    let mut tag = match Probe::open(path).and_then(|p| p.read()) {
        Ok(tagged) => tagged
            .primary_tag()
            .cloned()
            .or_else(|| tagged.first_tag().cloned())
            .unwrap_or_else(|| Tag::new(tag_type)),
        Err(_) => Tag::new(tag_type),
    };

    // Drop any existing front-cover pictures so we don't accumulate
    // duplicates on repeated embeds.
    tag.remove_picture_type(PictureType::CoverFront);

    tag.push_picture(Picture::new_unchecked(
        PictureType::CoverFront,
        Some(MimeType::Jpeg),
        None,
        jpeg_bytes.to_vec(),
    ));

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| AppError::Io(format!("Failed to write cover art: {}", e)))?;

    Ok(())
}

/// Read raw cover-art bytes (any picture type, first one) from an audio
/// file via lofty. Returns `None` for files without embedded art or
/// formats lofty can't parse.
pub fn read_cover_from_file(path: &Path) -> Option<Vec<u8>> {
    let tagged = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.pictures().first().map(|p| p.data().to_vec())
}

/// Write title/artist/album and an optional front-cover JPEG into the
/// file's primary tag. Empty string fields are skipped (existing values
/// preserved). Format-agnostic via lofty.
pub fn write_tags_to_file(
    path: &Path,
    title: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
    cover_jpeg: Option<&[u8]>,
) -> Result<(), AppError> {
    let tag_type = tag_type_for(path);

    let mut tag = match Probe::open(path).and_then(|p| p.read()) {
        Ok(tagged) => tagged
            .primary_tag()
            .cloned()
            .or_else(|| tagged.first_tag().cloned())
            .unwrap_or_else(|| Tag::new(tag_type)),
        Err(_) => Tag::new(tag_type),
    };

    if let Some(t) = title {
        if !t.is_empty() {
            tag.set_title(t.to_string());
        }
    }
    if let Some(a) = artist {
        if !a.is_empty() {
            tag.set_artist(a.to_string());
        }
    }
    if let Some(a) = album {
        if !a.is_empty() {
            tag.set_album(a.to_string());
        }
    }
    if let Some(jpeg) = cover_jpeg {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            jpeg.to_vec(),
        ));
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| AppError::Io(format!("Failed to write tags: {}", e)))?;
    Ok(())
}

// ============================================================
// MusicBrainz + Cover Art Archive
// ============================================================

async fn try_musicbrainz(title: &str, artist: &str) -> Option<Vec<u8>> {
    let query = if artist.is_empty() {
        title.to_string()
    } else {
        format!("{} {}", title, artist)
    };
    let url = format!(
        "https://musicbrainz.org/ws/2/recording?query={}&fmt=json&limit=3",
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?;

    let json: serde_json::Value = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    let recordings = json["recordings"].as_array()?;
    let artist_lc = artist.to_lowercase();

    for rec in recordings {
        let score = rec["score"].as_u64().unwrap_or(0) as u32;
        if score < MIN_MB_SCORE {
            continue;
        }
        let matched_artist = rec["artist-credit"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|ac| ac["artist"]["name"].as_str())
            .unwrap_or("")
            .to_lowercase();
        if !artist_lc.is_empty()
            && !matched_artist.contains(&artist_lc)
            && !artist_lc.contains(&matched_artist)
        {
            continue;
        }

        let releases = rec["releases"].as_array()?;
        for release in releases {
            let mbid = release["id"].as_str().unwrap_or("");
            if mbid.is_empty() {
                continue;
            }
            if let Some(bytes) = fetch_cover_art_archive(mbid).await {
                return Some(bytes);
            }
        }
    }

    None
}

async fn fetch_cover_art_archive(release_mbid: &str) -> Option<Vec<u8>> {
    let url = format!(
        "https://coverartarchive.org/release/{}/front-500",
        release_mbid
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?;
    let resp = client
        .get(&url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.is_empty() { None } else { Some(bytes.to_vec()) }
}

// ============================================================
// yt-dlp thumbnails
// ============================================================

fn is_supported_source(url: &str) -> bool {
    url.contains("youtube.com")
        || url.contains("youtu.be")
        || url.contains("soundcloud.com")
}

/// Run `yt-dlp -J --no-download <url_or_search>` and fetch the resulting
/// thumbnail URL. Returns (image_bytes, thumbnail_url).
async fn try_ytdlp_thumbnail(
    ytdlp_path: &Path,
    url_or_search: &str,
) -> Option<(Vec<u8>, Option<String>)> {
    let output = tokio::process::Command::new(ytdlp_path)
        .args(["--no-download", "-J", "--no-warnings", url_or_search])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;

    // For ytsearch queries we get a playlist; pull the first entry.
    let root = if let Some(entries) = json["entries"].as_array() {
        entries.first()?.clone()
    } else {
        json
    };

    let thumb_url = pick_best_thumbnail(&root)?;
    let bytes = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .ok()?
        .get(&thumb_url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .ok()?
        .bytes()
        .await
        .ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((bytes.to_vec(), Some(thumb_url)))
}

fn pick_best_thumbnail(entry: &serde_json::Value) -> Option<String> {
    if let Some(arr) = entry["thumbnails"].as_array() {
        // Prefer the largest available; thumbnails are usually sorted ascending.
        if let Some(best) = arr.iter().rev().find(|t| t["url"].is_string()) {
            return best["url"].as_str().map(|s| s.to_string());
        }
    }
    entry["thumbnail"].as_str().map(|s| s.to_string())
}

// ============================================================
// Image processing
// ============================================================

/// Decode arbitrary image bytes, center-crop to a square, encode as JPEG.
fn crop_square_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    let side = w.min(h);
    let x = (w - side) / 2;
    let y = (h - side) / 2;
    let cropped = img.crop_imm(x, y, side, side);

    // Cap output size to keep DB blobs reasonable.
    let final_img = if cropped.width() > 1000 {
        cropped.thumbnail(1000, 1000)
    } else {
        cropped
    };

    let mut buf = Vec::new();
    final_img
        .to_rgb8()
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .ok()?;
    Some(buf)
}

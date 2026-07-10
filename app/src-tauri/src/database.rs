use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// A single download record stored in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRecord {
    pub id: String,
    pub url: String,
    pub format: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_art_path: String,
    pub file_path: String,
    pub backend: String,
    pub message: String,
    pub playlist_title: String,
    pub created_at: String,
    /// Not stored in DB — populated at read time from embedded ID3 tags.
    #[serde(default)]
    pub cover_art_base64: String,
}

/// A playlist row with its track count.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub track_count: u32,
}

/// A YouTube channel subscription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub url: String,
    pub thumbnail: String,
    pub added_at: i64,
}

/// A single video from a subscribed channel's feed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedItem {
    pub video_id: String,
    pub channel_id: String,
    pub title: String,
    pub uploader: String,
    pub duration: u32,
    pub thumbnail: String,
    pub upload_date: String,
    pub url: String,
}

/// Thread-safe wrapper around a SQLite connection.
pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    /// Open (or create) the database at `app_data_dir/download_history.db`.
    pub fn new(app_data_dir: &Path) -> Result<Self, rusqlite::Error> {
        std::fs::create_dir_all(app_data_dir).ok();
        let db_path = app_data_dir.join("download_history.db");
        let conn = Connection::open(db_path)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS downloads (
                id         TEXT PRIMARY KEY,
                url        TEXT NOT NULL,
                format     TEXT NOT NULL,
                status     TEXT NOT NULL,
                title      TEXT NOT NULL DEFAULT '',
                artist     TEXT NOT NULL DEFAULT '',
                file_path  TEXT NOT NULL DEFAULT '',
                backend    TEXT NOT NULL DEFAULT '',
                message    TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );",
        )?;

        // Migrations: add columns if they don't exist yet
        conn.execute("ALTER TABLE downloads ADD COLUMN album TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("ALTER TABLE downloads ADD COLUMN cover_art_path TEXT NOT NULL DEFAULT ''", []).ok();
        conn.execute("ALTER TABLE downloads ADD COLUMN playlist_title TEXT NOT NULL DEFAULT ''", []).ok();

        // Library cache: folders the user has added + tracks scanned from them.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_folders (
                path TEXT PRIMARY KEY,
                added_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_tracks (
                path          TEXT PRIMARY KEY,
                folder        TEXT NOT NULL,
                filename      TEXT NOT NULL,
                title         TEXT NOT NULL DEFAULT '',
                artist        TEXT NOT NULL DEFAULT '',
                album         TEXT NOT NULL DEFAULT '',
                duration_secs INTEGER NOT NULL DEFAULT 0,
                mtime         INTEGER NOT NULL,
                size          INTEGER NOT NULL,
                cover_art     BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_library_tracks_folder ON library_tracks(folder);",
        )?;

        // Migration: track when each row was first scanned. Default to mtime
        // for legacy rows so they don't all collapse to "right now".
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN first_scanned_at INTEGER NOT NULL DEFAULT 0",
            [],
        ).ok();
        conn.execute(
            "UPDATE library_tracks SET first_scanned_at = mtime WHERE first_scanned_at = 0",
            [],
        ).ok();
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN bitrate_kbps INTEGER NOT NULL DEFAULT 0",
            [],
        ).ok();
        // Backfill bitrate for existing rows from cached size + duration.
        conn.execute(
            "UPDATE library_tracks SET bitrate_kbps = (size * 8 / duration_secs / 1000)
             WHERE bitrate_kbps = 0 AND duration_secs > 0",
            [],
        ).ok();
        // Whether bitrate_kbps came from the file's audio frame headers (0) or
        // was estimated from size/duration (1). Defaults to 1 for pre-existing
        // rows since we can't tell which path wrote them — the next scan will
        // re-read them via lofty and clear the flag.
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN bitrate_estimated INTEGER NOT NULL DEFAULT 1",
            [],
        ).ok();
        // Cached SoundCloud-style waveform: 500 bytes of 0-255 amplitude buckets.
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN waveform BLOB",
            [],
        ).ok();
        // Play tracking: bumped each time a track finishes naturally.
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0",
            [],
        ).ok();
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN last_played_at INTEGER NOT NULL DEFAULT 0",
            [],
        ).ok();
        // Content-detected container type ("MP3", "M4A", "FLAC", ...). Empty for
        // legacy rows; the scanner backfills it by re-reading such rows (see
        // library_tracks_fingerprint + the walk() skip condition).
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN file_type TEXT NOT NULL DEFAULT ''",
            [],
        ).ok();

        // Play history: one row per playback start, powering the "Recent" view.
        // Distinct from library_tracks.play_count (which only counts natural
        // finishes) — this logs every track you start, skips included.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS play_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                track_path TEXT NOT NULL,
                played_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC);",
        )?;

        // Playlists
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS playlists (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id TEXT NOT NULL,
                track_path  TEXT NOT NULL,
                position    INTEGER NOT NULL,
                added_at    INTEGER NOT NULL,
                PRIMARY KEY (playlist_id, track_path)
            );
            CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist
                ON playlist_tracks(playlist_id, position);",
        )?;

        // Tags (many-to-many with Last.fm weight)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
            CREATE TABLE IF NOT EXISTS track_tags (
                track_path TEXT NOT NULL,
                tag_id     INTEGER NOT NULL,
                weight     INTEGER NOT NULL DEFAULT 100,
                PRIMARY KEY (track_path, tag_id)
            );
            CREATE INDEX IF NOT EXISTS idx_track_tags_tag ON track_tags(tag_id);
            CREATE INDEX IF NOT EXISTS idx_track_tags_track ON track_tags(track_path);",
        )?;

        // YouTube channel subscriptions + feed
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS subscriptions (
                id        TEXT PRIMARY KEY,
                name      TEXT NOT NULL,
                url       TEXT NOT NULL,
                thumbnail TEXT NOT NULL DEFAULT '',
                added_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS feed_items (
                video_id    TEXT PRIMARY KEY,
                channel_id  TEXT NOT NULL,
                title       TEXT NOT NULL,
                uploader    TEXT NOT NULL,
                duration    INTEGER NOT NULL DEFAULT 0,
                thumbnail   TEXT NOT NULL DEFAULT '',
                upload_date TEXT NOT NULL DEFAULT '',
                fetched_at  INTEGER NOT NULL,
                url         TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feed_items_channel ON feed_items(channel_id);
            CREATE INDEX IF NOT EXISTS idx_feed_items_date ON feed_items(upload_date DESC);",
        )?;

        // Migration: track whether Last.fm tags have been fetched for a track.
        conn.execute(
            "ALTER TABLE library_tracks ADD COLUMN tags_fetched_at INTEGER NOT NULL DEFAULT 0",
            [],
        ).ok();

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // ===================== Library =====================

    pub fn list_library_folders(&self) -> Result<Vec<String>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM library_folders ORDER BY added_at ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    pub fn add_library_folder(&self, path: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO library_folders (path, added_at) VALUES (?1, ?2)",
            params![path, now_timestamp()],
        )?;
        Ok(())
    }

    pub fn remove_library_folder(&self, path: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM library_folders WHERE path = ?1", params![path])?;
        conn.execute("DELETE FROM library_tracks WHERE folder = ?1", params![path])?;
        Ok(())
    }

    /// Return (path, mtime, size, duration_secs, bitrate_kbps, bitrate_estimated,
    /// file_type) for every cached track in the given folder. The scanner uses
    /// these to detect rows that need re-reading even when mtime/size are
    /// unchanged (e.g. legacy rows missing values now produced by the lofty
    /// parser, rows with an estimated bitrate, or rows missing file_type).
    pub fn library_tracks_fingerprint(
        &self,
        folder: &str,
    ) -> Result<Vec<(String, i64, i64, i64, i64, bool, String)>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, mtime, size, duration_secs, bitrate_kbps, bitrate_estimated, file_type FROM library_tracks WHERE folder = ?1",
        )?;
        let rows = stmt.query_map(params![folder], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)? != 0,
                row.get::<_, String>(6)?,
            ))
        })?;
        rows.collect()
    }

    pub fn upsert_library_track(
        &self,
        folder: &str,
        track: &crate::library::LibraryTrack,
        mtime: i64,
        size: i64,
        cover_art_bytes: Option<&[u8]>,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // Bitrate is read directly from the file (lofty); fall back to a
        // size/duration approximation only if the reader didn't supply one.
        // The estimated flag tracks which path we took so the UI can mark
        // fallback values as uncertain.
        let (bitrate_kbps, bitrate_estimated): (i64, bool) = if track.bitrate_kbps > 0 {
            (track.bitrate_kbps as i64, false)
        } else if track.duration_secs > 0 {
            (((size * 8) / (track.duration_secs as i64) / 1000).max(0), true)
        } else {
            (0, false)
        };
        // Insert if new; otherwise update everything except first_scanned_at.
        conn.execute(
            "INSERT INTO library_tracks
             (path, folder, filename, title, artist, album, duration_secs, mtime, size, cover_art, first_scanned_at, bitrate_kbps, bitrate_estimated, file_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(path) DO UPDATE SET
                folder = excluded.folder,
                filename = excluded.filename,
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                duration_secs = excluded.duration_secs,
                mtime = excluded.mtime,
                size = excluded.size,
                cover_art = excluded.cover_art,
                bitrate_kbps = excluded.bitrate_kbps,
                bitrate_estimated = excluded.bitrate_estimated,
                file_type = excluded.file_type",
            params![
                track.path,
                folder,
                track.filename,
                track.title,
                track.artist,
                track.album,
                track.duration_secs,
                mtime,
                size,
                cover_art_bytes,
                now,
                bitrate_kbps,
                bitrate_estimated as i64,
                track.file_type,
            ],
        )?;
        Ok(())
    }

    /// Replace just the cover_art BLOB on a library track. Also bumps mtime/size
    /// to reflect the on-disk write so the next scan doesn't redundantly re-read.
    pub fn update_library_cover(&self, path: &str, cover_bytes: &[u8]) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let meta = std::fs::metadata(path).ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
        conn.execute(
            "UPDATE library_tracks SET cover_art = ?1, mtime = ?2, size = ?3 WHERE path = ?4",
            params![cover_bytes, mtime, size, path],
        )?;
        Ok(())
    }

    pub fn record_library_play(&self, path: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        conn.execute(
            "UPDATE library_tracks
             SET play_count = play_count + 1, last_played_at = ?1
             WHERE path = ?2",
            params![now, path],
        )?;
        Ok(())
    }

    /// Append a playback-start event to the history log. Called when a track
    /// begins playing (skips included) — see `get_recently_played`.
    pub fn record_play_start(&self, path: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO play_history (track_path, played_at) VALUES (?1, ?2)",
            params![path, now],
        )?;
        Ok(())
    }

    /// Load the most recent play events (newest first, repeats included),
    /// joined to their library track metadata. Events for tracks no longer in
    /// the library are omitted.
    pub fn get_recently_played(
        &self,
        limit: i64,
    ) -> Result<Vec<crate::library::PlayHistoryEntry>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        // Bulk load tags once (avoids N+1), matching get_all_library_tracks.
        let tag_map = {
            let mut stmt = conn.prepare(
                "SELECT tt.track_path, t.name, tt.weight
                 FROM track_tags tt JOIN tags t ON tt.tag_id = t.id
                 ORDER BY tt.track_path, tt.weight DESC",
            )?;
            let mut map: HashMap<String, Vec<String>> = HashMap::new();
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (path, tag) = row?;
                let entry = map.entry(path).or_default();
                if entry.len() < 5 {
                    entry.push(tag);
                }
            }
            map
        };

        let mut stmt = conn.prepare(
            "SELECT ph.id, ph.played_at,
                    lt.path, lt.filename, lt.title, lt.artist, lt.album, lt.duration_secs,
                    lt.cover_art, lt.first_scanned_at, lt.bitrate_kbps, lt.play_count,
                    lt.last_played_at, lt.bitrate_estimated, lt.file_type
             FROM play_history ph
             JOIN library_tracks lt ON lt.path = ph.track_path
             ORDER BY ph.played_at DESC, ph.id DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            let path: String = row.get(2)?;
            let cover: Option<Vec<u8>> = row.get(8)?;
            let cover_b64 = cover
                .map(|b| base64::engine::general_purpose::STANDARD.encode(&b))
                .unwrap_or_default();
            Ok(crate::library::PlayHistoryEntry {
                id: row.get(0)?,
                played_at: row.get(1)?,
                track: crate::library::LibraryTrack {
                    tags: tag_map.get(&path).cloned().unwrap_or_default(),
                    path,
                    filename: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    album: row.get(6)?,
                    duration_secs: row.get::<_, i64>(7)? as u32,
                    cover_art_base64: cover_b64,
                    first_scanned_at: row.get::<_, i64>(9)?,
                    bitrate_kbps: row.get::<_, i64>(10)? as u32,
                    play_count: row.get::<_, i64>(11)? as u32,
                    last_played_at: row.get::<_, i64>(12)?,
                    bitrate_estimated: row.get::<_, i64>(13)? != 0,
                    file_type: row.get::<_, String>(14)?,
                },
            })
        })?;
        rows.collect()
    }

    pub fn get_library_waveform(&self, path: &str) -> Result<Option<Vec<u8>>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT waveform FROM library_tracks WHERE path = ?1")?;
        let mut rows = stmt.query(params![path])?;
        if let Some(row) = rows.next()? {
            Ok(row.get::<_, Option<Vec<u8>>>(0)?)
        } else {
            Ok(None)
        }
    }

    pub fn set_library_waveform(&self, path: &str, bytes: &[u8]) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE library_tracks SET waveform = ?1 WHERE path = ?2",
            params![bytes, path],
        )?;
        Ok(())
    }

    /// Look up the source URL for a downloaded file. Returns None if there's
    /// no matching download record.
    pub fn find_download_url_for_path(&self, file_path: &str) -> Result<Option<String>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT url FROM downloads WHERE file_path = ?1 LIMIT 1",
        )?;
        let mut rows = stmt.query(params![file_path])?;
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Update the path of a track (after rename) and its tag fields.
    /// Used by metadata-edit flows; preserves first_scanned_at.
    pub fn update_library_track_after_edit(
        &self,
        old_path: &str,
        new_path: &str,
        title: &str,
        artist: &str,
        album: &str,
        cover_art_bytes: Option<&[u8]>,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let new_filename = std::path::Path::new(new_path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = std::fs::metadata(new_path).ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);

        if let Some(bytes) = cover_art_bytes {
            conn.execute(
                "UPDATE library_tracks
                 SET path = ?1, filename = ?2, title = ?3, artist = ?4, album = ?5,
                     mtime = ?6, size = ?7, cover_art = ?8
                 WHERE path = ?9",
                params![new_path, new_filename, title, artist, album, mtime, size, bytes, old_path],
            )?;
        } else {
            conn.execute(
                "UPDATE library_tracks
                 SET path = ?1, filename = ?2, title = ?3, artist = ?4, album = ?5,
                     mtime = ?6, size = ?7
                 WHERE path = ?8",
                params![new_path, new_filename, title, artist, album, mtime, size, old_path],
            )?;
        }
        // Cascade path change to related tables
        if old_path != new_path {
            conn.execute(
                "UPDATE playlist_tracks SET track_path = ?1 WHERE track_path = ?2",
                params![new_path, old_path],
            )?;
            conn.execute(
                "UPDATE track_tags SET track_path = ?1 WHERE track_path = ?2",
                params![new_path, old_path],
            )?;
        }
        Ok(())
    }

    /// Update a track's path/filename and cached content type after an
    /// extension fix, cascading the path change to related tables. `new_path`
    /// may equal `old_path` (type-only refresh with no rename).
    pub fn update_track_path_and_type(
        &self,
        old_path: &str,
        new_path: &str,
        file_type: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let new_filename = std::path::Path::new(new_path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = std::fs::metadata(new_path).ok();
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        conn.execute(
            "UPDATE library_tracks
             SET path = ?1, filename = ?2, file_type = ?3, mtime = ?4
             WHERE path = ?5",
            params![new_path, new_filename, file_type, mtime, old_path],
        )?;
        if old_path != new_path {
            conn.execute(
                "UPDATE playlist_tracks SET track_path = ?1 WHERE track_path = ?2",
                params![new_path, old_path],
            )?;
            conn.execute(
                "UPDATE track_tags SET track_path = ?1 WHERE track_path = ?2",
                params![new_path, old_path],
            )?;
        }
        Ok(())
    }

    pub fn delete_library_tracks(&self, paths: &[String]) -> Result<(), rusqlite::Error> {
        if paths.is_empty() { return Ok(()); }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for p in paths {
            tx.execute("DELETE FROM playlist_tracks WHERE track_path = ?1", params![p])?;
            tx.execute("DELETE FROM track_tags WHERE track_path = ?1", params![p])?;
            tx.execute("DELETE FROM library_tracks WHERE path = ?1", params![p])?;
        }
        tx.commit()
    }

    /// Load all cached library tracks with cover art as base64 and tags.
    pub fn get_all_library_tracks(&self) -> Result<Vec<crate::library::LibraryTrack>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();

        // Bulk load tags first (single query, not N+1)
        let tag_map = {
            let mut stmt = conn.prepare(
                "SELECT tt.track_path, t.name, tt.weight
                 FROM track_tags tt JOIN tags t ON tt.tag_id = t.id
                 ORDER BY tt.track_path, tt.weight DESC",
            )?;
            let mut map: HashMap<String, Vec<String>> = HashMap::new();
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (path, tag) = row?;
                let entry = map.entry(path).or_default();
                if entry.len() < 5 {
                    entry.push(tag);
                }
            }
            map
        };

        let mut stmt = conn.prepare(
            "SELECT path, filename, title, artist, album, duration_secs, cover_art, first_scanned_at, bitrate_kbps, play_count, last_played_at, bitrate_estimated, file_type
             FROM library_tracks
             ORDER BY LOWER(artist), LOWER(album), LOWER(title)",
        )?;
        let rows = stmt.query_map([], |row| {
            let path: String = row.get(0)?;
            let cover: Option<Vec<u8>> = row.get(6)?;
            let cover_b64 = cover
                .map(|b| base64::engine::general_purpose::STANDARD.encode(&b))
                .unwrap_or_default();
            Ok(crate::library::LibraryTrack {
                tags: tag_map.get(&path).cloned().unwrap_or_default(),
                path,
                filename: row.get(1)?,
                title: row.get(2)?,
                artist: row.get(3)?,
                album: row.get(4)?,
                duration_secs: row.get::<_, i64>(5)? as u32,
                cover_art_base64: cover_b64,
                first_scanned_at: row.get::<_, i64>(7)?,
                bitrate_kbps: row.get::<_, i64>(8)? as u32,
                play_count: row.get::<_, i64>(9)? as u32,
                last_played_at: row.get::<_, i64>(10)?,
                bitrate_estimated: row.get::<_, i64>(11)? != 0,
                file_type: row.get::<_, String>(12)?,
            })
        })?;
        rows.collect()
    }

    /// Insert or replace a download record.
    pub fn insert_or_update(&self, r: &DownloadRecord) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO downloads
             (id, url, format, status, title, artist, album, cover_art_path, file_path, backend, message, playlist_title, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                r.id,
                r.url,
                r.format,
                r.status,
                r.title,
                r.artist,
                r.album,
                r.cover_art_path,
                r.file_path,
                r.backend,
                r.message,
                r.playlist_title,
                r.created_at,
            ],
        )?;
        Ok(())
    }

    /// Return all records ordered by newest first.
    pub fn get_all(&self) -> Result<Vec<DownloadRecord>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, url, format, status, title, artist, album, cover_art_path, file_path, backend, message, playlist_title, created_at
             FROM downloads ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(DownloadRecord {
                id: row.get(0)?,
                url: row.get(1)?,
                format: row.get(2)?,
                status: row.get(3)?,
                title: row.get(4)?,
                artist: row.get(5)?,
                album: row.get(6)?,
                cover_art_path: row.get(7)?,
                file_path: row.get(8)?,
                backend: row.get(9)?,
                message: row.get(10)?,
                playlist_title: row.get(11)?,
                created_at: row.get(12)?,
                cover_art_base64: String::new(),
            })
        })?;

        rows.collect()
    }

    /// Update metadata fields for a record (after editing MP3 tags).
    pub fn update_metadata(
        &self,
        id: &str,
        title: &str,
        artist: &str,
        file_path: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET title = ?1, artist = ?2, file_path = ?3 WHERE id = ?4",
            params![title, artist, file_path, id],
        )?;
        Ok(())
    }

    /// Update metadata fields including album and cover art path.
    pub fn update_full_metadata(
        &self,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        cover_art_path: &str,
        file_path: &str,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE downloads SET title = ?1, artist = ?2, album = ?3, cover_art_path = ?4, file_path = ?5 WHERE id = ?6",
            params![title, artist, album, cover_art_path, file_path, id],
        )?;
        Ok(())
    }

    /// Delete a single record.
    pub fn remove(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete all records.
    pub fn clear_all(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM downloads", [])?;
        Ok(())
    }

    // ===================== Playlists =====================

    pub fn create_playlist(&self, id: &str, name: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let now = now_unix();
        conn.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, now, now],
        )?;
        Ok(())
    }

    pub fn rename_playlist(&self, id: &str, name: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now_unix(), id],
        )?;
        Ok(())
    }

    pub fn delete_playlist(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![id])?;
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_playlists(&self) -> Result<Vec<PlaylistRow>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.created_at, p.updated_at,
                    (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
             FROM playlists p ORDER BY p.updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PlaylistRow {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                track_count: row.get::<_, i64>(4)? as u32,
            })
        })?;
        rows.collect()
    }

    pub fn get_playlist_track_paths(&self, playlist_id: &str) -> Result<Vec<String>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT track_path FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![playlist_id], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    pub fn add_tracks_to_playlist(&self, playlist_id: &str, paths: &[String]) -> Result<(), rusqlite::Error> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let max_pos: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?1",
                params![playlist_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);
        let now = now_unix();
        for (i, path) in paths.iter().enumerate() {
            tx.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_path, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![playlist_id, path, max_pos + 1 + i as i64, now],
            )?;
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;
        tx.commit()
    }

    pub fn remove_track_from_playlist(&self, playlist_id: &str, track_path: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_path = ?2",
            params![playlist_id, track_path],
        )?;
        conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now_unix(), playlist_id],
        )?;
        Ok(())
    }

    pub fn reorder_playlist_tracks(&self, playlist_id: &str, paths: &[String]) -> Result<(), rusqlite::Error> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )?;
        let now = now_unix();
        for (i, path) in paths.iter().enumerate() {
            tx.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_path, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![playlist_id, path, i as i64, now],
            )?;
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )?;
        tx.commit()
    }

    // ===================== Tags =====================

    /// Replace all tags for a track. `tags` is a list of (normalized_name, weight).
    pub fn set_track_tags(&self, track_path: &str, tags: &[(String, i32)]) -> Result<(), rusqlite::Error> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM track_tags WHERE track_path = ?1", params![track_path])?;
        for (name, weight) in tags {
            tx.execute(
                "INSERT OR IGNORE INTO tags (name) VALUES (?1)",
                params![name],
            )?;
            let tag_id: i64 = tx.query_row(
                "SELECT id FROM tags WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )?;
            tx.execute(
                "INSERT INTO track_tags (track_path, tag_id, weight) VALUES (?1, ?2, ?3)",
                params![track_path, tag_id, weight],
            )?;
        }
        let now = now_unix();
        tx.execute(
            "UPDATE library_tracks SET tags_fetched_at = ?1 WHERE path = ?2",
            params![now, track_path],
        )?;
        tx.commit()
    }

    /// All tags with their usage count, sorted by count descending.
    pub fn get_all_tags(&self) -> Result<Vec<(i64, String, i64)>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, COUNT(tt.track_path) as cnt
             FROM tags t JOIN track_tags tt ON t.id = tt.tag_id
             GROUP BY t.id ORDER BY cnt DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?;
        rows.collect()
    }

    /// Bulk load: for every track, return its top 3 tags by weight.
    /// Returns HashMap<track_path, Vec<tag_name>>.
    pub fn get_all_track_tags(&self) -> Result<HashMap<String, Vec<String>>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tt.track_path, t.name, tt.weight
             FROM track_tags tt JOIN tags t ON tt.tag_id = t.id
             ORDER BY tt.track_path, tt.weight DESC",
        )?;
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (path, tag) = row?;
            let entry = map.entry(path).or_default();
            if entry.len() < 5 {
                entry.push(tag);
            }
        }
        Ok(map)
    }

    /// Return tracks that haven't had tags fetched yet.
    pub fn tracks_needing_tag_fetch(&self, limit: u32) -> Result<Vec<(String, String, String)>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, title, artist FROM library_tracks
             WHERE tags_fetched_at = 0 AND artist != '' LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        rows.collect()
    }

    // ===================== Feed / Subscriptions =====================

    pub fn add_subscription(&self, id: &str, name: &str, url: &str, thumbnail: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO subscriptions (id, name, url, thumbnail, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, url, thumbnail, now_unix()],
        )?;
        Ok(())
    }

    pub fn remove_subscription(&self, id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM feed_items WHERE channel_id = ?1", params![id])?;
        conn.execute("DELETE FROM subscriptions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_subscriptions(&self) -> Result<Vec<Subscription>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, url, thumbnail, added_at FROM subscriptions ORDER BY added_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Subscription {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                thumbnail: row.get(3)?,
                added_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_feed_items(&self, items: &[FeedItem]) -> Result<(), rusqlite::Error> {
        if items.is_empty() { return Ok(()); }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let now = now_unix();
        for item in items {
            tx.execute(
                "INSERT INTO feed_items (video_id, channel_id, title, uploader, duration, thumbnail, upload_date, fetched_at, url)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(video_id) DO UPDATE SET
                    title = excluded.title,
                    duration = excluded.duration,
                    thumbnail = excluded.thumbnail,
                    upload_date = excluded.upload_date",
                params![item.video_id, item.channel_id, item.title, item.uploader, item.duration, item.thumbnail, item.upload_date, now, item.url],
            )?;
        }
        tx.commit()
    }

    pub fn get_feed_items(&self, limit: u32) -> Result<Vec<FeedItem>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT f.video_id, f.channel_id, f.title, COALESCE(s.name, f.uploader) as uploader,
                    f.duration, f.thumbnail, f.upload_date, f.url
             FROM feed_items f LEFT JOIN subscriptions s ON f.channel_id = s.id
             ORDER BY f.upload_date DESC, f.fetched_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(FeedItem {
                video_id: row.get(0)?,
                channel_id: row.get(1)?,
                title: row.get(2)?,
                uploader: row.get(3)?,
                duration: row.get::<_, i64>(4)? as u32,
                thumbnail: row.get(5)?,
                upload_date: row.get(6)?,
                url: row.get(7)?,
            })
        })?;
        rows.collect()
    }
}

/// Current unix timestamp as i64.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Current unix timestamp as a string.
pub fn now_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

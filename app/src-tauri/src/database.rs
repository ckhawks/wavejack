use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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

    /// Return (path, mtime, size, duration_secs, bitrate_kbps) for every cached
    /// track in the given folder. The scanner uses duration/bitrate to detect
    /// rows that need re-reading even when mtime/size are unchanged
    /// (e.g. legacy rows missing values now produced by the lofty parser).
    pub fn library_tracks_fingerprint(
        &self,
        folder: &str,
    ) -> Result<Vec<(String, i64, i64, i64, i64)>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, mtime, size, duration_secs, bitrate_kbps FROM library_tracks WHERE folder = ?1",
        )?;
        let rows = stmt.query_map(params![folder], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
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
        let bitrate_kbps: i64 = if track.bitrate_kbps > 0 {
            track.bitrate_kbps as i64
        } else if track.duration_secs > 0 {
            ((size * 8) / (track.duration_secs as i64) / 1000).max(0)
        } else {
            0
        };
        // Insert if new; otherwise update everything except first_scanned_at.
        conn.execute(
            "INSERT INTO library_tracks
             (path, folder, filename, title, artist, album, duration_secs, mtime, size, cover_art, first_scanned_at, bitrate_kbps)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                bitrate_kbps = excluded.bitrate_kbps",
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
        Ok(())
    }

    pub fn delete_library_tracks(&self, paths: &[String]) -> Result<(), rusqlite::Error> {
        if paths.is_empty() { return Ok(()); }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for p in paths {
            tx.execute("DELETE FROM library_tracks WHERE path = ?1", params![p])?;
        }
        tx.commit()
    }

    /// Load all cached library tracks with cover art as base64.
    pub fn get_all_library_tracks(&self) -> Result<Vec<crate::library::LibraryTrack>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, filename, title, artist, album, duration_secs, cover_art, first_scanned_at, bitrate_kbps, play_count, last_played_at
             FROM library_tracks
             ORDER BY LOWER(artist), LOWER(album), LOWER(title)",
        )?;
        let rows = stmt.query_map([], |row| {
            let cover: Option<Vec<u8>> = row.get(6)?;
            let cover_b64 = cover
                .map(|b| base64::engine::general_purpose::STANDARD.encode(&b))
                .unwrap_or_default();
            Ok(crate::library::LibraryTrack {
                path: row.get(0)?,
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
}

/// Current unix timestamp as a string.
pub fn now_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

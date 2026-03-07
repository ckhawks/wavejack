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
    pub file_path: String,
    pub backend: String,
    pub message: String,
    pub created_at: String,
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

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert or replace a download record.
    pub fn insert_or_update(&self, r: &DownloadRecord) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO downloads
             (id, url, format, status, title, artist, file_path, backend, message, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                r.id,
                r.url,
                r.format,
                r.status,
                r.title,
                r.artist,
                r.file_path,
                r.backend,
                r.message,
                r.created_at,
            ],
        )?;
        Ok(())
    }

    /// Return all records ordered by newest first.
    pub fn get_all(&self) -> Result<Vec<DownloadRecord>, rusqlite::Error> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, url, format, status, title, artist, file_path, backend, message, created_at
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
                file_path: row.get(6)?,
                backend: row.get(7)?,
                message: row.get(8)?,
                created_at: row.get(9)?,
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

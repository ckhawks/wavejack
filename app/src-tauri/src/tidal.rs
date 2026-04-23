// tidal.rs — Tidal catalog search + OAuth device-code login.
//
// Mirrors rekordbox-mem/src/extractor/tools/tidal_coverage.py. The intent is
// narrow: given a Spotify track (ISRC + artist + title + duration), find the
// equivalent Tidal track ID. Download is delegated to `tidal-dl-ng` (see
// downloader.rs) — this module does not touch audio streams.
//
// Auth: Tidal's OAuth device-code flow. The well-known "TV" client credentials
// baked into the open-source `tidalapi` Python library are used; they're
// documented public values that allow catalog search on an ordinary account.
// The user approves Wavejack at tidal.com/authorize in their browser, then we
// poll the token endpoint until approval lands.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const AUTH_BASE: &str = "https://auth.tidal.com/v1/oauth2";
const API_BASE: &str = "https://api.tidal.com/v1";
// Tidal's newer JSON:API endpoint used by tidalapi for ISRC lookups — the
// legacy v1 /tracks/byisrc endpoint was retired.
const OPENAPI_BASE: &str = "https://openapi.tidal.com/v2";
// "TV" client used by tidalapi — works for catalog search on a normal account.
const CLIENT_ID: &str = "zU4XHVVkc2tDPo4t";
const CLIENT_SECRET: &str = "VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4=";
// OAuth2 scope strings are space-separated per RFC; reqwest form-encodes spaces
// to `+` on the wire, so this is the correct source form.
const SCOPE: &str = "r_usr w_usr w_sub";
const DURATION_TOLERANCE_SEC: i64 = 3;

// ------- persisted token ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedToken {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    country_code: String,
    user_id: u64,
}

impl CachedToken {
    fn expired(&self) -> bool {
        now_secs() + 30 >= self.expires_at
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn token_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Settings(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("tidal_token.json"))
}

fn load_cached_token(app: &AppHandle) -> Option<CachedToken> {
    let path = token_path(app).ok()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_cached_token(app: &AppHandle, token: &CachedToken) -> Result<(), AppError> {
    let path = token_path(app)?;
    std::fs::write(
        path,
        serde_json::to_string(token).map_err(|e| AppError::Settings(e.to_string()))?,
    )?;
    Ok(())
}

fn clear_cached_token(app: &AppHandle) -> Result<(), AppError> {
    let path = token_path(app)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

// ------- device-code flow --------------------------------------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct DeviceAuthResponse {
    #[serde(rename = "deviceCode")]
    device_code: String,
    #[serde(rename = "userCode")]
    user_code: String,
    #[serde(rename = "verificationUri")]
    verification_uri: String,
    #[serde(rename = "verificationUriComplete")]
    verification_uri_complete: String,
    #[serde(default = "default_interval")]
    interval: u64,
    #[serde(rename = "expiresIn", default = "default_expires_in")]
    expires_in: u64,
}

fn default_interval() -> u64 { 2 }
fn default_expires_in() -> u64 { 300 }

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    user: Option<TokenUser>,
}

#[derive(Debug, Deserialize)]
struct TokenUser {
    #[serde(rename = "userId", alias = "id")]
    user_id: u64,
    #[serde(rename = "countryCode", default)]
    country_code: String,
}

#[derive(Debug, Deserialize)]
struct TokenError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Kick off a device-code flow. Returns the URL the user should open and the
/// device code to poll with.
async fn start_device_flow() -> Result<DeviceAuthResponse, AppError> {
    let mut form = HashMap::new();
    form.insert("client_id", CLIENT_ID);
    form.insert("scope", SCOPE);

    let resp = reqwest::Client::new()
        .post(format!("{}/device_authorization", AUTH_BASE))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::Settings(format!("Tidal device auth failed: {}", e)))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Settings(format!("Tidal device auth HTTP {}: {}", status, body)));
    }
    serde_json::from_str::<DeviceAuthResponse>(&body).map_err(|e| {
        AppError::Settings(format!(
            "Tidal device auth: couldn't parse response ({}). Body: {}",
            e, body
        ))
    })
}

async fn poll_for_token(device_code: &str, interval: u64, deadline: u64) -> Result<CachedToken, AppError> {
    let client = reqwest::Client::new();
    let mut sleep_secs = interval.max(2);
    loop {
        if now_secs() >= deadline {
            return Err(AppError::Settings("Tidal login timed out — user did not approve in time".into()));
        }
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;

        let mut form = HashMap::new();
        form.insert("client_id", CLIENT_ID);
        form.insert("client_secret", CLIENT_SECRET);
        form.insert("device_code", device_code);
        form.insert("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
        form.insert("scope", SCOPE);

        let resp = client
            .post(format!("{}/token", AUTH_BASE))
            .form(&form)
            .send()
            .await
            .map_err(|e| AppError::Settings(format!("Tidal token poll failed: {}", e)))?;

        if resp.status().is_success() {
            let body: TokenResponse = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
            let user = body.user.ok_or_else(|| {
                AppError::Settings("Tidal token response missing user info".into())
            })?;
            return Ok(CachedToken {
                access_token: body.access_token,
                refresh_token: body.refresh_token.ok_or_else(|| {
                    AppError::Settings("Tidal omitted refresh_token".into())
                })?,
                expires_at: now_secs() + body.expires_in,
                country_code: if user.country_code.is_empty() { "US".into() } else { user.country_code },
                user_id: user.user_id,
            });
        }

        // Expected: 400 with error=authorization_pending or slow_down while user hasn't approved yet.
        let status = resp.status();
        let err: TokenError = resp.json().await.unwrap_or(TokenError {
            error: format!("http_{}", status),
            error_description: None,
        });
        match err.error.as_str() {
            "authorization_pending" => continue,
            "slow_down" => {
                sleep_secs = sleep_secs.saturating_add(1);
                continue;
            }
            "expired_token" | "access_denied" => {
                return Err(AppError::Settings(format!(
                    "Tidal login rejected: {}",
                    err.error_description.unwrap_or(err.error)
                )));
            }
            other => {
                return Err(AppError::Settings(format!(
                    "Tidal token poll unexpected error '{}': {}",
                    other,
                    err.error_description.unwrap_or_default()
                )));
            }
        }
    }
}

async fn refresh_token(cached: &CachedToken) -> Result<CachedToken, AppError> {
    let mut form = HashMap::new();
    form.insert("client_id", CLIENT_ID);
    form.insert("client_secret", CLIENT_SECRET);
    form.insert("refresh_token", cached.refresh_token.as_str());
    form.insert("grant_type", "refresh_token");
    form.insert("scope", SCOPE);

    let resp = reqwest::Client::new()
        .post(format!("{}/token", AUTH_BASE))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::Settings(format!("Tidal refresh failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Settings(format!("Tidal refresh HTTP {}: {}", status, body)));
    }
    let body: TokenResponse = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
    Ok(CachedToken {
        access_token: body.access_token,
        refresh_token: body.refresh_token.unwrap_or_else(|| cached.refresh_token.clone()),
        expires_at: now_secs() + body.expires_in,
        country_code: cached.country_code.clone(),
        user_id: cached.user_id,
    })
}

async fn ensure_token(app: &AppHandle) -> Result<CachedToken, AppError> {
    let Some(cached) = load_cached_token(app) else {
        return Err(AppError::Settings("Not logged in to Tidal".into()));
    };
    if !cached.expired() {
        return Ok(cached);
    }
    match refresh_token(&cached).await {
        Ok(refreshed) => {
            save_cached_token(app, &refreshed)?;
            Ok(refreshed)
        }
        Err(e) => {
            // Tidal's TV client tokens get revoked on their schedule — when a
            // refresh comes back 401 (`invalid_client` / `invalid_grant`) there
            // is no recovery short of re-running the device-code flow. Drop the
            // stale token so `tidal_auth_status` starts reporting logged-out,
            // and signal the UI to prompt for re-auth.
            eprintln!("[tidal] refresh failed, clearing cached token: {}", e);
            let _ = clear_cached_token(app);
            let _ = app.emit("tidal-auth-expired", ());
            Err(e)
        }
    }
}

// ------- public types ------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct TidalUser {
    pub id: u64,
    pub country_code: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TidalDeviceAuth {
    /// The URL to open in the browser — already includes the user code.
    pub verification_url: String,
    /// Short code the user can type manually if the URL fails.
    pub user_code: String,
    /// Opaque code Wavejack polls the token endpoint with.
    pub device_code: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Tidal catalog search for the URL/search box.
///
/// Returns an empty vec if the user isn't logged in (so callers can compose
/// this with yt-dlp / SoundCloud searches without needing to pre-check auth).
pub async fn search_for_box(
    app: &AppHandle,
    query: &str,
    limit: u32,
) -> Vec<crate::discover::SearchResult> {
    eprintln!("[tidal] search_for_box(query={:?}, limit={})", query, limit);
    let token = match ensure_token(app).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tidal] search_for_box: ensure_token failed: {}", e);
            return Vec::new();
        }
    };
    eprintln!("[tidal] search_for_box: got token (country={})", token.country_code);
    let tracks = match search_tracks(&token, query, limit).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[tidal] search_for_box: search_tracks failed: {}", e);
            return Vec::new();
        }
    };
    eprintln!("[tidal] search_for_box: got {} result(s)", tracks.len());
    tracks
        .into_iter()
        .map(|t| {
            let artist = t
                .artists
                .iter()
                .map(|a| a.name.clone())
                .collect::<Vec<_>>()
                .join(", ");
            let duration = t.duration.max(0) as u32;
            let thumbnail_url = t
                .album
                .as_ref()
                .and_then(|a| a.cover.as_deref())
                .map(|uuid| tidal_cover_url(uuid, 160))
                .unwrap_or_default();
            crate::discover::SearchResult {
                id: format!("tidal-{}", t.id),
                title: t.title,
                artist,
                duration_secs: duration,
                thumbnail_url,
                source: "tidal".to_string(),
                url: format!("https://tidal.com/browse/track/{}", t.id),
            }
        })
        .collect()
}

/// Input for a match lookup — a trimmed Spotify track.
#[derive(Debug, Clone, Deserialize)]
pub struct MatchInput {
    pub spotify_id: String,
    pub name: String,
    pub artists: Vec<String>,
    pub isrc: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchStatus {
    FoundIsrc,
    FoundFuzzy,
    NotFound,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TidalMatch {
    pub spotify_id: String,
    pub status: MatchStatus,
    pub tidal_id: Option<u64>,
    pub tidal_title: Option<String>,
    pub tidal_artists: Option<Vec<String>>,
    /// "HIGH" | "LOSSLESS" | "HI_RES_LOSSLESS" when available.
    pub tidal_quality: Option<String>,
    pub tidal_url: Option<String>,
    pub reason: Option<String>,
}

// ------- search ------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SearchTrack {
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    duration: i64,
    #[serde(default, rename = "audioQuality")]
    audio_quality: Option<String>,
    // Populated by the byisrc endpoint; stripped by generic search. Kept so we
    // can surface it if a later Tidal API revision starts including it.
    #[serde(default)]
    isrc: Option<String>,
    #[serde(default)]
    artists: Vec<SearchArtist>,
    #[serde(default)]
    album: Option<SearchAlbum>,
}

#[derive(Debug, Deserialize)]
struct SearchArtist {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct SearchAlbum {
    /// UUID-with-dashes like "0b0e2f4a-8b3e-4c5c-9f76-01a2b3c4d5e6".
    /// Resolve to an image URL via `tidal_cover_url`.
    #[serde(default)]
    cover: Option<String>,
}

/// Tidal cover art: the UUID in `album.cover` maps to
/// `https://resources.tidal.com/images/<uuid-with-slashes>/<size>.jpg`.
/// Available sizes: 80, 160, 320, 640, 1280. We pick 160 for search rows.
fn tidal_cover_url(uuid: &str, size: u32) -> String {
    let path = uuid.replace('-', "/");
    format!("https://resources.tidal.com/images/{}/{}x{}.jpg", path, size, size)
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    #[serde(default)]
    items: Vec<SearchTrack>,
}

// --- ISRC lookup via openapi.tidal.com/v2 (JSON:API) ---------------------

#[derive(Debug, Deserialize)]
struct OpenApiResponse {
    #[serde(default)]
    data: Vec<OpenApiItem>,
}

#[derive(Debug, Deserialize)]
struct OpenApiItem {
    id: String,
}

/// Try Tidal's newer JSON:API endpoint. Returns `Ok(Some(track_id))` on a
/// successful hit, `Ok(None)` if the ISRC isn't on Tidal, and `Err` on
/// auth/transport failure so the caller can decide to fall back.
async fn isrc_via_openapi(token: &CachedToken, isrc: &str) -> Result<Option<u64>, AppError> {
    // The `filter[isrc]` bracket syntax is JSON:API convention; Tidal is
    // strict about encoding so we serialize by hand.
    let url = format!(
        "{}/tracks?filter%5Bisrc%5D={}&countryCode={}",
        OPENAPI_BASE,
        urlencoding::encode(isrc),
        token.country_code,
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&token.access_token)
        .header("Accept", "application/vnd.api+json")
        .send()
        .await
        .map_err(|e| AppError::Settings(format!("openapi ISRC call failed: {}", e)))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        eprintln!("[tidal] openapi byisrc {} -> HTTP {}: {}", isrc, status,
            body.chars().take(200).collect::<String>());
        return Err(AppError::Settings(format!("openapi HTTP {}", status)));
    }
    let parsed: OpenApiResponse = serde_json::from_str(&body).map_err(|e| {
        AppError::Settings(format!("openapi parse: {} (body: {})", e,
            body.chars().take(200).collect::<String>()))
    })?;
    let hit = parsed.data.first().and_then(|i| i.id.parse::<u64>().ok());
    eprintln!("[tidal] openapi byisrc {} -> {} hit(s){}",
        isrc,
        parsed.data.len(),
        hit.map(|id| format!(" (id={})", id)).unwrap_or_default(),
    );
    Ok(hit)
}

// --- ISRC lookup fallback: v1 search + per-track detail ------------------

/// Fetch full track detail (includes `isrc` field) from v1.
async fn v1_track_detail(token: &CachedToken, id: u64) -> Result<Option<SearchTrack>, AppError> {
    let url = format!("{}/tracks/{}?countryCode={}", API_BASE, id, token.country_code);
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|e| AppError::Settings(format!("v1 track detail failed: {}", e)))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(AppError::Settings(format!("v1 track detail HTTP {}", resp.status())));
    }
    let t: SearchTrack = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
    Ok(Some(t))
}

/// Resolve an ISRC to a Tidal track using v1 search: the search endpoint
/// *does* index ISRCs (just doesn't expose the field), so we query for the
/// ISRC string and verify the top hit by re-fetching via `/tracks/{id}`,
/// which *does* include `isrc`. Duration sanity-check guards against
/// false positives from Tidal's fuzzy query parser.
async fn isrc_via_v1_search(
    token: &CachedToken,
    isrc: &str,
    expected_duration_sec: i64,
) -> Result<Option<SearchTrack>, AppError> {
    let items = search_tracks(token, isrc, 3).await?;
    eprintln!("[tidal] v1 search(isrc={}) -> {} item(s)", isrc, items.len());
    for item in items {
        let Some(detail) = v1_track_detail(token, item.id).await? else { continue };
        let matches_isrc = detail.isrc.as_deref().map(|s| s.eq_ignore_ascii_case(isrc)).unwrap_or(false);
        let duration_ok = expected_duration_sec <= 0
            || (detail.duration - expected_duration_sec).abs() <= DURATION_TOLERANCE_SEC;
        eprintln!(
            "[tidal]   v1 detail id={} isrc={:?} dur={}s isrc_match={} dur_ok={}",
            detail.id, detail.isrc, detail.duration, matches_isrc, duration_ok,
        );
        if matches_isrc && duration_ok {
            return Ok(Some(detail));
        }
    }
    Ok(None)
}

async fn search_tracks(
    token: &CachedToken,
    query: &str,
    limit: u32,
) -> Result<Vec<SearchTrack>, AppError> {
    // Truncate overly long queries — Tidal rejects >120 chars on some plans.
    let q: String = query.chars().take(120).collect();
    let url = format!(
        "{}/search/tracks?query={}&limit={}&countryCode={}",
        API_BASE,
        urlencoding::encode(&q),
        limit,
        token.country_code,
    );
    for attempt in 0..4u32 {
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|e| AppError::Settings(format!("Tidal search failed: {}", e)))?;
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
            continue;
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Settings(format!("Tidal search HTTP {}: {}", status, body)));
        }
        let parsed: SearchResponse = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
        return Ok(parsed.items);
    }
    Err(AppError::Settings(format!("Tidal search for {:?} exhausted retries", q)))
}

fn to_tidal_match(
    spotify_id: &str,
    status: MatchStatus,
    track: &SearchTrack,
) -> TidalMatch {
    TidalMatch {
        spotify_id: spotify_id.to_string(),
        status,
        tidal_id: Some(track.id),
        tidal_title: Some(track.title.clone()),
        tidal_artists: Some(track.artists.iter().map(|a| a.name.clone()).collect()),
        tidal_quality: track.audio_quality.clone(),
        tidal_url: Some(format!("https://tidal.com/browse/track/{}", track.id)),
        reason: None,
    }
}

/// Match a single Spotify track on Tidal: ISRC first (via search + ISRC
/// verification), fuzzy fallback on artist+title with duration ±3s.
async fn match_one(token: &CachedToken, input: &MatchInput) -> TidalMatch {
    eprintln!(
        "[tidal] match_one spotify_id={} title={:?} artists={:?} isrc={:?} dur={}ms",
        input.spotify_id, input.name, input.artists, input.isrc, input.duration_ms,
    );

    let target_sec = (input.duration_ms / 1000) as i64;

    // ISRC path: try the modern openapi endpoint first; on any failure or
    // empty result, fall through to v1 search + detail verification.
    if let Some(isrc) = input.isrc.as_ref().filter(|s| !s.is_empty()) {
        match isrc_via_openapi(token, isrc).await {
            Ok(Some(id)) => {
                // openapi gave us an ID but not full track info; fetch details
                // from v1 so we have title/artists/quality to display.
                match v1_track_detail(token, id).await {
                    Ok(Some(detail)) => {
                        eprintln!("[tidal]   -> ISRC hit via openapi: id={} title={:?}", detail.id, detail.title);
                        return to_tidal_match(&input.spotify_id, MatchStatus::FoundIsrc, &detail);
                    }
                    Ok(None) => eprintln!("[tidal]   -> openapi id {} not found on v1, trying search", id),
                    Err(e) => eprintln!("[tidal]   -> openapi id {} detail error: {}", id, e),
                }
            }
            Ok(None) => eprintln!("[tidal]   -> openapi: ISRC not on Tidal, trying v1 search"),
            Err(e) => eprintln!("[tidal]   -> openapi failed ({}), trying v1 search", e),
        }

        match isrc_via_v1_search(token, isrc, target_sec).await {
            Ok(Some(detail)) => {
                eprintln!("[tidal]   -> ISRC hit via v1 search+detail: id={} title={:?}", detail.id, detail.title);
                return to_tidal_match(&input.spotify_id, MatchStatus::FoundIsrc, &detail);
            }
            Ok(None) => eprintln!("[tidal]   -> v1 search+detail: no ISRC match, falling back to fuzzy"),
            Err(e) => eprintln!("[tidal]   -> v1 search+detail error: {} (falling back to fuzzy)", e),
        }
    } else {
        eprintln!("[tidal]   -> no ISRC on Spotify track, going fuzzy");
    }

    // Fuzzy fallback: artist+title with duration verification.
    let q = format!("{} {}", input.artists.join(", "), input.name);
    let items = match search_tracks(token, &q, 10).await {
        Ok(v) => v,
        Err(e) => {
            return TidalMatch {
                spotify_id: input.spotify_id.clone(),
                status: MatchStatus::Error,
                tidal_id: None,
                tidal_title: None,
                tidal_artists: None,
                tidal_quality: None,
                tidal_url: None,
                reason: Some(format!("fuzzy search error: {}", e)),
            };
        }
    };
    let mut best: Option<(&SearchTrack, i64)> = None;
    for t in &items {
        let delta = (t.duration - target_sec).abs();
        if delta <= DURATION_TOLERANCE_SEC && best.map_or(true, |(_, d)| delta < d) {
            best = Some((t, delta));
        }
    }
    if let Some((t, _)) = best {
        return to_tidal_match(&input.spotify_id, MatchStatus::FoundFuzzy, t);
    }

    TidalMatch {
        spotify_id: input.spotify_id.clone(),
        status: MatchStatus::NotFound,
        tidal_id: None,
        tidal_title: None,
        tidal_artists: None,
        tidal_quality: None,
        tidal_url: None,
        reason: None,
    }
}

// ------- command entry points ----------------------------------------------

/// Shared module state: pending device-code flow, so `tidal_login_start` can
/// return the URL immediately and `tidal_login_finish` can await approval.
/// One flow at a time — starting a second overwrites the first.
static PENDING_DEVICE: tokio::sync::Mutex<Option<PendingDevice>> = tokio::sync::Mutex::const_new(None);

#[derive(Clone)]
struct PendingDevice {
    device_code: String,
    interval: u64,
    deadline: u64,
}

pub async fn tidal_login_start_cmd() -> Result<TidalDeviceAuth, AppError> {
    let dev = start_device_flow().await?;
    let deadline = now_secs() + dev.expires_in;
    *PENDING_DEVICE.lock().await = Some(PendingDevice {
        device_code: dev.device_code.clone(),
        interval: dev.interval,
        deadline,
    });
    // tidalapi returns `verificationUriComplete` without a scheme (e.g. "link.tidal.com/ABCDE");
    // normalize to a full https URL so the frontend can open it directly.
    let url = if dev.verification_uri_complete.starts_with("http") {
        dev.verification_uri_complete.clone()
    } else {
        format!("https://{}", dev.verification_uri_complete)
    };
    // Best-effort browser open; on failure the UI still shows the URL.
    let _ = webbrowser::open(&url);
    Ok(TidalDeviceAuth {
        verification_url: url,
        user_code: dev.user_code,
        device_code: dev.device_code,
        expires_in: dev.expires_in,
        interval: dev.interval,
    })
}

pub async fn tidal_login_finish_cmd(app: AppHandle) -> Result<TidalUser, AppError> {
    let pending = PENDING_DEVICE.lock().await.take().ok_or_else(|| {
        AppError::Settings("No Tidal login in progress — call tidal_login_start first".into())
    })?;
    let token = poll_for_token(&pending.device_code, pending.interval, pending.deadline).await?;
    let user = TidalUser { id: token.user_id, country_code: token.country_code.clone() };
    save_cached_token(&app, &token)?;
    let _ = app.emit("tidal-auth-changed", true);
    Ok(user)
}

pub fn tidal_auth_status_cmd(app: AppHandle) -> Option<TidalUser> {
    load_cached_token(&app).map(|t| TidalUser { id: t.user_id, country_code: t.country_code })
}

pub fn tidal_logout_cmd(app: AppHandle) -> Result<(), AppError> {
    clear_cached_token(&app)?;
    let _ = app.emit("tidal-auth-changed", false);
    Ok(())
}

pub async fn tidal_match_tracks_cmd(
    app: AppHandle,
    tracks: Vec<MatchInput>,
) -> Result<Vec<TidalMatch>, AppError> {
    let token = ensure_token(&app).await?;
    let mut out = Vec::with_capacity(tracks.len());
    for (i, t) in tracks.iter().enumerate() {
        let m = match_one(&token, t).await;
        // Emit progress so the UI can update a counter. Per-track events are
        // cheap and let us show "matching 42/100" without re-rendering the
        // whole list.
        use tauri::Emitter;
        let _ = app.emit("tidal-match-progress", serde_json::json!({
            "index": i,
            "total": tracks.len(),
            "match": &m,
        }));
        out.push(m);
        // Rate-limit: ~3.3 tracks/sec. Each track can fire 1–3 Tidal API
        // calls (openapi, v1 search, v1 detail), so actual request rate is
        // up to ~10/sec peak — well under anything Tidal rate-limits.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(out)
}


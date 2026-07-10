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

use crate::auth_cache;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const TOKEN_FILE: &str = "tidal_token.json";

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
// ±5s covers the typical drift between Spotify's metadata duration and the
// duration baked into Tidal masters. Tighter values produced false negatives
// on tracks where one source rounded a fade-out differently.
const DURATION_TOLERANCE_SEC: i64 = 5;

/// ISRCs are 12 chars, all alphanumeric ASCII (CC-XXX-YY-NNNNN with the
/// dashes stripped). Anything else burns API quota and risks rate-limit
/// pressure on the shared "TV" client credentials.
fn is_valid_isrc(s: &str) -> bool {
    s.len() == 12 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

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

fn load_cached_token(app: &AppHandle) -> Option<CachedToken> {
    auth_cache::load(app, TOKEN_FILE)
}

fn save_cached_token(app: &AppHandle, token: &CachedToken) -> Result<(), AppError> {
    auth_cache::save(app, TOKEN_FILE, token)
}

fn clear_cached_token(app: &AppHandle) -> Result<(), AppError> {
    auth_cache::clear(app, TOKEN_FILE)
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

// Serialize concurrent refresh attempts. Without this, two parallel callers
// can both observe the cached token as expired, both POST the same
// refresh_token, and the slower one comes back invalid_grant — Tidal
// invalidates the old refresh_token as soon as a new pair is issued.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn ensure_token(app: &AppHandle) -> Result<CachedToken, AppError> {
    let Some(cached) = load_cached_token(app) else {
        return Err(AppError::Settings("Not logged in to Tidal".into()));
    };
    if !cached.expired() {
        return Ok(cached);
    }
    let _guard = REFRESH_LOCK.lock().await;
    // Re-check after acquiring the lock — a peer may have refreshed already.
    if let Some(reread) = load_cached_token(app) {
        if !reread.expired() {
            return Ok(reread);
        }
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
    // Populated by /tracks/{id} (v1 detail endpoint); generic search responses
    // omit it. Used to verify ISRC fallback search hits.
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

// --- HTTP retry helpers --------------------------------------------------
//
// Tidal doesn't publish rate limits for either the openapi or the private v1
// surface, but it does return 429 with a `Retry-After` header under load. These
// helpers let every GET honor that header instead of hammering blindly.

/// Total attempts for a retryable (429/5xx) Tidal GET before giving up.
const TIDAL_MAX_RETRIES: u32 = 4;

/// Parse a `Retry-After` header (delta-seconds form) into a Duration. Tidal
/// returns integer seconds; we ignore the RFC HTTP-date form since Tidal
/// doesn't use it. Capped at 60s so a hostile/huge value can't wedge the match
/// loop while the preview modal is open.
fn retry_after_delay(resp: &reqwest::Response) -> Option<Duration> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|secs| Duration::from_secs(secs.min(60)))
}

/// How long to wait before retrying a 429/5xx: honor Tidal's `Retry-After`
/// header when present, otherwise exponential backoff (500ms, 1s, 2s, 4s).
fn backoff_delay(resp: &reqwest::Response, attempt: u32) -> Duration {
    retry_after_delay(resp).unwrap_or_else(|| Duration::from_millis(500 * (1 << attempt)))
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
    for attempt in 0..TIDAL_MAX_RETRIES {
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token.access_token)
            .header("Accept", "application/vnd.api+json")
            .send()
            .await
            .map_err(|e| AppError::Settings(format!("openapi ISRC call failed: {}", e)))?;
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            let delay = backoff_delay(&resp, attempt);
            eprintln!("[tidal] openapi byisrc {} -> HTTP {}, retry in {:?}", isrc, status, delay);
            tokio::time::sleep(delay).await;
            continue;
        }
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
        return Ok(hit);
    }
    Err(AppError::Settings(format!("openapi ISRC {} exhausted retries", isrc)))
}

// --- ISRC lookup fallback: v1 search + per-track detail ------------------

/// Fetch full track detail (includes `isrc` field) from v1.
async fn v1_track_detail(token: &CachedToken, id: u64) -> Result<Option<SearchTrack>, AppError> {
    let url = format!("{}/tracks/{}?countryCode={}", API_BASE, id, token.country_code);
    for attempt in 0..TIDAL_MAX_RETRIES {
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|e| AppError::Settings(format!("v1 track detail failed: {}", e)))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            let delay = backoff_delay(&resp, attempt);
            eprintln!("[tidal] v1 detail id={} -> HTTP {}, retry in {:?}", id, status, delay);
            tokio::time::sleep(delay).await;
            continue;
        }
        if !status.is_success() {
            return Err(AppError::Settings(format!("v1 track detail HTTP {}", status)));
        }
        let t: SearchTrack = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
        return Ok(Some(t));
    }
    Err(AppError::Settings(format!("v1 track detail id={} exhausted retries", id)))
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
    for attempt in 0..TIDAL_MAX_RETRIES {
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|e| AppError::Settings(format!("Tidal search failed: {}", e)))?;
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            let delay = backoff_delay(&resp, attempt);
            eprintln!("[tidal] search {:?} -> HTTP {}, retry in {:?}", q, status, delay);
            tokio::time::sleep(delay).await;
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
    if let Some(isrc) = input.isrc.as_ref().filter(|s| is_valid_isrc(s)) {
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

// ------- SoundCloud → Tidal match ------------------------------------------
//
// SoundCloud exposes no ISRC, so this path is fuzzy-only: clean the freeform
// title/uploader into (artist, title) via `ytdlp::clean_sc_metadata`, search
// Tidal, and pick the closest candidate by duration. Every result — including
// low-confidence ones — is surfaced for the user to review and confirm; we
// never silently swap a SoundCloud source for a guessed Tidal track.

// ------- fuzzy string similarity (for SoundCloud matching) -----------------

/// Filler tokens that add noise to music-title/artist comparison.
const MATCH_STOPWORDS: &[&str] = &["feat", "ft", "featuring", "prod", "with", "the"];

/// Lowercase and split into tokens, breaking on non-alphanumerics *and* on
/// digit↔letter boundaries so "4AM" and "4 AM" tokenize identically
/// (`["4", "am"]`). `&` is normalized to "and" first.
fn tokenize_lower(s: &str) -> Vec<String> {
    let lower = s.to_lowercase().replace('&', " and ");
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut cur_digit = false;
    for ch in lower.chars() {
        if ch.is_alphanumeric() {
            let d = ch.is_numeric();
            if !cur.is_empty() && d != cur_digit {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
            cur_digit = d;
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Token set for comparison, with filler words dropped.
fn token_set(s: &str) -> HashSet<String> {
    tokenize_lower(s)
        .into_iter()
        .filter(|t| !MATCH_STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// Sørensen–Dice coefficient over two token sets: `2·|A∩B| / (|A|+|B|)`.
/// Symmetric and length-sensitive, so "Sun Models" vs "Sun Models (X Remix)"
/// scores well below 1.0 — exactly the discrimination we want between an
/// original and a remix.
fn dice(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f64;
    2.0 * inter / (a.len() as f64 + b.len() as f64)
}

/// Similarity gate: a Tidal candidate must clear all of these to be accepted as
/// a SoundCloud match. Tuned for precision — the user would rather keep the
/// SoundCloud original than get a wrong Tidal track.
const TITLE_MIN: f64 = 0.6;
const ARTIST_MIN: f64 = 0.5;
/// Max duration gap (seconds) when the SoundCloud duration is known. Different
/// edits/versions usually differ by more than this.
const SC_DUR_GATE_SEC: i64 = 5;

/// Score a Tidal candidate against the cleaned SoundCloud (artist, title).
/// Returns `None` if it fails any gate, else `(score, duration_delta)`.
fn score_candidate(
    q_title: &HashSet<String>,
    q_artist: &HashSet<String>,
    candidate: &SearchTrack,
    target_sec: Option<i64>,
) -> Option<(f64, i64)> {
    let c_title = token_set(&candidate.title);
    let c_artist_joined = candidate
        .artists
        .iter()
        .map(|a| a.name.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let c_artist = token_set(&c_artist_joined);

    let title_sim = dice(q_title, &c_title);
    // When we couldn't derive a SoundCloud artist (no dash, uploader was a
    // label), don't penalize on artist — lean on title + duration instead.
    let artist_sim = if q_artist.is_empty() { 1.0 } else { dice(q_artist, &c_artist) };
    let delta = target_sec.map(|t| (candidate.duration - t).abs());

    let dur_ok = delta.is_none_or(|d| d <= SC_DUR_GATE_SEC);
    if !dur_ok || title_sim < TITLE_MIN || artist_sim < ARTIST_MIN {
        return None;
    }

    let dur_score = match delta {
        Some(d) => 1.0 - (d as f64 / SC_DUR_GATE_SEC as f64),
        None => 0.5, // unknown duration — neutral contribution
    };
    let score = 0.55 * title_sim + 0.30 * artist_sim + 0.15 * dur_score;
    Some((score, delta.unwrap_or(0)))
}

/// One SoundCloud playlist entry to match. `index` keys the result back to the
/// playlist row on the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct ScMatchInput {
    pub index: usize,
    pub title: String,
    pub uploader: Option<String>,
    /// Track length in seconds (yt-dlp reports fractional); optional because
    /// `--flat-playlist` occasionally omits it.
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScTidalMatch {
    pub index: usize,
    pub status: MatchStatus,
    /// The cleaned artist/title we actually searched Tidal with — shown in the
    /// preview so the user can compare "what we asked for" vs. "what came back".
    pub query_artist: String,
    pub query_title: String,
    pub tidal_id: Option<u64>,
    pub tidal_title: Option<String>,
    pub tidal_artists: Option<Vec<String>>,
    pub tidal_quality: Option<String>,
    pub tidal_url: Option<String>,
    /// Absolute duration gap (seconds) between the SoundCloud track and the
    /// chosen Tidal candidate, when both are known. Lets the UI flag shaky
    /// matches without dropping them.
    pub duration_delta_sec: Option<i64>,
    /// Match confidence 0.0–1.0 (title/artist/duration blend) for accepted
    /// matches. `None` when nothing cleared the similarity gate.
    pub confidence: Option<f64>,
    pub reason: Option<String>,
}

/// Fuzzy-match one SoundCloud entry on Tidal. No ISRC path exists for
/// SoundCloud, so this always returns `FoundFuzzy`, `NotFound`, or `Error`.
async fn match_one_sc(token: &CachedToken, input: &ScMatchInput) -> ScTidalMatch {
    let (artist, title) =
        crate::ytdlp::clean_sc_metadata(&input.title, input.uploader.as_deref());
    // Only trust a positive, sane duration for the proximity pick.
    let target_sec = input.duration.map(|d| d.round() as i64).filter(|d| *d > 0);

    let base = ScTidalMatch {
        index: input.index,
        status: MatchStatus::NotFound,
        query_artist: artist.clone(),
        query_title: title.clone(),
        tidal_id: None,
        tidal_title: None,
        tidal_artists: None,
        tidal_quality: None,
        tidal_url: None,
        duration_delta_sec: None,
        confidence: None,
        reason: None,
    };

    let query = if artist.is_empty() { title.clone() } else { format!("{} {}", artist, title) };
    if query.trim().is_empty() {
        return ScTidalMatch { reason: Some("empty query after cleaning title".into()), ..base };
    }

    eprintln!("[tidal] sc match_one index={} query={:?} target={:?}s", input.index, query, target_sec);
    let items = match search_tracks(token, &query, 12).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tidal]   -> sc search error: {}", e);
            return ScTidalMatch { status: MatchStatus::Error, reason: Some(e.to_string()), ..base };
        }
    };
    if items.is_empty() {
        eprintln!("[tidal]   -> sc no results");
        return base; // NotFound
    }

    // Score every candidate on title + artist similarity (with a hard duration
    // gate) and keep the highest scorer that clears the thresholds. Anything
    // that fails the gates leaves this a NotFound — we do NOT fall back to a
    // duration-only guess, which is what produced the earlier wrong matches.
    let q_title = token_set(&title);
    let q_artist = token_set(&artist);
    let mut best: Option<(&SearchTrack, f64, i64)> = None;
    for c in &items {
        if let Some((score, delta)) = score_candidate(&q_title, &q_artist, c, target_sec) {
            if best.is_none_or(|(_, s, _)| score > s) {
                best = Some((c, score, delta));
            }
        }
    }

    let Some((track, score, delta)) = best else {
        eprintln!("[tidal]   -> sc no candidate cleared the similarity gate");
        return base; // NotFound
    };
    eprintln!(
        "[tidal]   -> sc hit id={} title={:?} score={:.2} delta={}s",
        track.id, track.title, score, delta,
    );

    ScTidalMatch {
        status: MatchStatus::FoundFuzzy,
        tidal_id: Some(track.id),
        tidal_title: Some(track.title.clone()),
        tidal_artists: Some(track.artists.iter().map(|a| a.name.clone()).collect()),
        tidal_quality: track.audio_quality.clone(),
        tidal_url: Some(format!("https://tidal.com/browse/track/{}", track.id)),
        duration_delta_sec: target_sec.map(|_| delta),
        confidence: Some((score * 100.0).round() / 100.0),
        reason: None,
        ..base
    }
}

/// Match every entry of a SoundCloud playlist against Tidal. Emits a
/// `tidal-sc-match-progress` event per entry so the UI can show a counter.
pub async fn tidal_match_soundcloud_cmd(
    app: AppHandle,
    entries: Vec<ScMatchInput>,
) -> Result<Vec<ScTidalMatch>, AppError> {
    let token = ensure_token(&app).await?;
    let mut out = Vec::with_capacity(entries.len());
    for (i, e) in entries.iter().enumerate() {
        let m = match_one_sc(&token, e).await;
        let _ = app.emit("tidal-sc-match-progress", serde_json::json!({
            "index": i,
            "total": entries.len(),
            "match": &m,
        }));
        out.push(m);
        // Same conservative ~3.3/sec pacing as the Spotify matcher.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, artists: &[&str], duration: i64) -> SearchTrack {
        SearchTrack {
            id: 1,
            title: title.to_string(),
            duration,
            audio_quality: Some("LOSSLESS".to_string()),
            isrc: None,
            artists: artists
                .iter()
                .map(|n| SearchArtist { name: n.to_string() })
                .collect(),
            album: None,
        }
    }

    #[test]
    fn tokenize_splits_digit_letter_boundary() {
        assert_eq!(tokenize_lower("4AM"), vec!["4", "am"]);
        assert_eq!(tokenize_lower("4 AM"), vec!["4", "am"]);
    }

    #[test]
    fn dice_identical_is_one() {
        assert!((dice(&token_set("Strobe"), &token_set("Strobe")) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn accepts_exact_title_artist_and_duration() {
        let q_title = token_set("4 AM");
        let q_artist = token_set("Kaskade");
        let c = track("4 AM", &["Kaskade"], 300);
        assert!(score_candidate(&q_title, &q_artist, &c, Some(301)).is_some());
    }

    #[test]
    fn rejects_wrong_title_even_with_close_duration() {
        let q_title = token_set("Strobe");
        let q_artist = token_set("deadmau5");
        // Same artist + near-identical duration, but a completely different song.
        let c = track("Ghosts N Stuff", &["deadmau5"], 300);
        assert!(score_candidate(&q_title, &q_artist, &c, Some(300)).is_none());
    }

    #[test]
    fn rejects_wrong_artist() {
        let q_title = token_set("Strobe");
        let q_artist = token_set("deadmau5");
        let c = track("Strobe", &["Some Coverband"], 300);
        assert!(score_candidate(&q_title, &q_artist, &c, Some(300)).is_none());
    }

    #[test]
    fn rejects_when_duration_gate_fails() {
        let q_title = token_set("4 AM");
        let q_artist = token_set("Kaskade");
        let c = track("4 AM", &["Kaskade"], 300);
        // 20s off — different edit/version.
        assert!(score_candidate(&q_title, &q_artist, &c, Some(320)).is_none());
    }

    #[test]
    fn distinguishes_original_from_remix() {
        let q_title = token_set("Sun Models (Bear Grillz Remix)");
        let q_artist = token_set("ODESZA");
        // Original, not the remix the SoundCloud title asked for.
        let original = track("Sun Models", &["ODESZA"], 200);
        assert!(score_candidate(&q_title, &q_artist, &original, Some(200)).is_none());
        // The actual remix clears the gate.
        let remix = track("Sun Models (Bear Grillz Remix)", &["ODESZA", "Bear Grillz"], 200);
        assert!(score_candidate(&q_title, &q_artist, &remix, Some(200)).is_some());
    }

    #[test]
    fn no_artist_leans_on_title_and_duration() {
        let q_title = token_set("Brightest Lights");
        let q_artist: HashSet<String> = HashSet::new(); // uploader was a label; dropped
        let c = track("Brightest Lights", &["Lane 8"], 240);
        assert!(score_candidate(&q_title, &q_artist, &c, Some(240)).is_some());
    }
}


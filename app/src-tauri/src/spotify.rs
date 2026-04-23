// spotify.rs — Spotify Web API client: PKCE OAuth + playlist fetching.
//
// Mirrors the Python reference at
// rekordbox-mem/src/extractor/tools/spotify_inventory.py but ported to Rust
// for in-process use. Scope: paste-a-playlist-URL flow only — we fetch the
// metadata Wavejack needs to feed Tidal matching (ISRC, artist, title,
// duration). No Liked Songs / playlist enumeration for v1.
//
// Auth: Authorization Code flow with PKCE. A one-shot axum listener on
// 127.0.0.1:8888 catches the OAuth redirect. Tokens (access + refresh) are
// cached at {app_data_dir}/spotify_token.json and auto-refresh when expired.

use crate::error::AppError;
use axum::{extract::{Query, State}, response::Html, routing::get, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distr::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::{oneshot, Mutex};
use url::form_urlencoded;

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API_BASE: &str = "https://api.spotify.com/v1";
const REDIRECT_URI: &str = "http://127.0.0.1:8888/callback";
const CALLBACK_PORT: u16 = 8888;
const SCOPES: &str = "user-library-read playlist-read-private playlist-read-collaborative";

// ------- persisted token ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedToken {
    access_token: String,
    refresh_token: String,
    /// Unix seconds when this access token expires.
    expires_at: u64,
}

impl CachedToken {
    fn expired(&self) -> bool {
        // 30s grace to avoid racing expiry.
        now_secs() + 30 >= self.expires_at
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn token_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Settings(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("spotify_token.json"))
}

fn load_cached_token(app: &AppHandle) -> Option<CachedToken> {
    let path = token_path(app).ok()?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_cached_token(app: &AppHandle, token: &CachedToken) -> Result<(), AppError> {
    let path = token_path(app)?;
    std::fs::write(path, serde_json::to_string(token).map_err(|e| AppError::Settings(e.to_string()))?)?;
    Ok(())
}

fn clear_cached_token(app: &AppHandle) -> Result<(), AppError> {
    let path = token_path(app)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

// ------- PKCE helpers ------------------------------------------------------

fn pkce_pair() -> (String, String) {
    // 64 bytes of entropy → 128-char urlsafe verifier (capped to 128 per RFC7636).
    let verifier: String = rand::rng()
        .sample_iter(&Alphanumeric)
        .take(96)
        .map(char::from)
        .collect();
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn rand_state() -> String {
    rand::rng().sample_iter(&Alphanumeric).take(24).map(char::from).collect()
}

// ------- settings access ---------------------------------------------------

fn read_setting(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store("settings.json").ok()?;
    store.get(key).and_then(|v| v.as_str().map(|s| s.to_string()))
}

fn client_creds(app: &AppHandle) -> Result<(String, String), AppError> {
    let id = read_setting(app, "spotifyClientId").unwrap_or_default();
    let secret = read_setting(app, "spotifyClientSecret").unwrap_or_default();
    if id.is_empty() || secret.is_empty() {
        return Err(AppError::Settings(
            "Spotify client ID/secret not set. Add them in Settings → Spotify.".into(),
        ));
    }
    Ok((id, secret))
}

// ------- token exchange / refresh ------------------------------------------

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
) -> Result<CachedToken, AppError> {
    let mut form = HashMap::new();
    form.insert("grant_type", "authorization_code");
    form.insert("code", code);
    form.insert("redirect_uri", REDIRECT_URI);
    form.insert("client_id", client_id);
    form.insert("code_verifier", verifier);

    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .basic_auth(client_id, Some(client_secret))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::Settings(format!("Token exchange failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Settings(format!("Token exchange HTTP {}: {}", status, body)));
    }
    let body: TokenResponse = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
    Ok(CachedToken {
        access_token: body.access_token,
        refresh_token: body.refresh_token.ok_or_else(|| {
            AppError::Settings("Spotify omitted refresh_token on first exchange".into())
        })?,
        expires_at: now_secs() + body.expires_in,
    })
}

async fn refresh_token(
    client_id: &str,
    client_secret: &str,
    existing: &CachedToken,
) -> Result<CachedToken, AppError> {
    let mut form = HashMap::new();
    form.insert("grant_type", "refresh_token");
    form.insert("refresh_token", existing.refresh_token.as_str());

    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .basic_auth(client_id, Some(client_secret))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::Settings(format!("Token refresh failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Settings(format!("Token refresh HTTP {}: {}", status, body)));
    }
    let body: TokenResponse = resp.json().await.map_err(|e| AppError::Settings(e.to_string()))?;
    Ok(CachedToken {
        access_token: body.access_token,
        // Spotify often omits refresh_token on refresh — reuse the old one.
        refresh_token: body.refresh_token.unwrap_or_else(|| existing.refresh_token.clone()),
        expires_at: now_secs() + body.expires_in,
    })
}

// ------- callback listener -------------------------------------------------

#[derive(Debug)]
struct AuthResult {
    code: String,
    state: String,
}

#[derive(Clone)]
struct CallbackState {
    tx: Arc<Mutex<Option<oneshot::Sender<Result<AuthResult, String>>>>>,
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback_handler(
    State(state): State<CallbackState>,
    Query(q): Query<CallbackQuery>,
) -> Html<&'static str> {
    let mut slot = state.tx.lock().await;
    if let Some(tx) = slot.take() {
        let result = if let Some(e) = q.error {
            Err(format!("auth error: {}", e))
        } else if let (Some(code), Some(st)) = (q.code, q.state) {
            Ok(AuthResult { code, state: st })
        } else {
            Err("missing code or state in callback".into())
        };
        let _ = tx.send(result);
    }
    Html(
        "<!doctype html><html><body style=\"font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh\">\
         <div style=\"text-align:center\"><h2>Spotify connected</h2><p>You can close this tab.</p></div></body></html>",
    )
}

/// Run the full interactive auth flow: spin up the callback listener, open the
/// browser, wait for redirect, exchange code for tokens. Blocks until done
/// or 5-minute timeout.
async fn interactive_login(app: &AppHandle) -> Result<CachedToken, AppError> {
    let (client_id, client_secret) = client_creds(app)?;
    let (verifier, challenge) = pkce_pair();
    let state_tok = rand_state();

    let (tx, rx) = oneshot::channel::<Result<AuthResult, String>>();
    let cb_state = CallbackState { tx: Arc::new(Mutex::new(Some(tx))) };

    let router = Router::new()
        .route("/callback", get(callback_handler))
        .with_state(cb_state);

    let addr = SocketAddr::from(([127, 0, 0, 1], CALLBACK_PORT));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| AppError::Settings(format!(
            "Can't bind {} for Spotify callback ({}). Is another Wavejack login already in progress?", addr, e
        )))?;

    // Graceful shutdown triggered once we receive the callback (or timeout).
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { let _ = shutdown_rx.await; })
            .await;
    });

    // Open the authorize URL in the user's browser.
    let query = form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPES)
        .append_pair("state", &state_tok)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", &challenge)
        .finish();
    let auth_url = format!("{}?{}", AUTH_URL, query);
    if webbrowser::open(&auth_url).is_err() {
        eprintln!("Spotify: couldn't open browser automatically. Visit: {}", auth_url);
    }

    // Wait for the callback or timeout.
    let auth = tokio::time::timeout(Duration::from_secs(300), rx)
        .await
        .map_err(|_| AppError::Settings("Spotify login timed out after 5 min".into()))?
        .map_err(|_| AppError::Settings("Spotify login channel dropped".into()))?
        .map_err(AppError::Settings)?;

    let _ = shutdown_tx.send(());
    let _ = server.await;

    if auth.state != state_tok {
        return Err(AppError::Settings("Spotify state mismatch (possible CSRF)".into()));
    }

    let token = exchange_code(&client_id, &client_secret, &auth.code, &verifier).await?;
    save_cached_token(app, &token)?;
    Ok(token)
}

/// Get a valid access token. Refreshes if cached-but-expired; runs the full
/// interactive flow if no cache exists.
async fn ensure_token(app: &AppHandle) -> Result<String, AppError> {
    if let Some(cached) = load_cached_token(app) {
        if !cached.expired() {
            return Ok(cached.access_token);
        }
        let (id, secret) = client_creds(app)?;
        match refresh_token(&id, &secret, &cached).await {
            Ok(new) => {
                save_cached_token(app, &new)?;
                return Ok(new.access_token);
            }
            Err(e) => {
                eprintln!("Spotify refresh failed, re-running interactive flow: {}", e);
                // Fall through to interactive.
            }
        }
    }
    let token = interactive_login(app).await?;
    Ok(token.access_token)
}

// ------- public types sent to frontend -------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SpotifyTrack {
    pub id: String,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    pub isrc: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub playlist_url: String,
    pub tracks: Vec<SpotifyTrack>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpotifyUser {
    pub id: String,
    pub display_name: String,
}

/// Return a cached + refreshed token without triggering the interactive login
/// flow. Used by paths that should silently no-op when the user isn't authed.
async fn try_valid_token(app: &AppHandle) -> Option<String> {
    let cached = load_cached_token(app)?;
    if !cached.expired() {
        return Some(cached.access_token);
    }
    let (id, secret) = client_creds(app).ok()?;
    match refresh_token(&id, &secret, &cached).await {
        Ok(new) => {
            let _ = save_cached_token(app, &new);
            Some(new.access_token)
        }
        Err(_) => None,
    }
}

/// Spotify catalog search for the URL/search box.
///
/// Returns an empty vec if the user isn't logged in or credentials aren't
/// configured — callers compose this alongside other sources.
pub async fn search_for_box(
    app: &AppHandle,
    query: &str,
    limit: u32,
) -> Vec<crate::discover::SearchResult> {
    let Some(token) = try_valid_token(app).await else {
        return Vec::new();
    };
    let url = format!(
        "https://api.spotify.com/v1/search?q={}&type=track&limit={}",
        urlencoding::encode(query),
        limit,
    );
    let json = match api_get(&token, &url).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[spotify] search_for_box failed: {}", e);
            return Vec::new();
        }
    };
    let items = json
        .get("tracks")
        .and_then(|t| t.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    items
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let name = item.get("name")?.as_str()?.to_string();
            let artists = item
                .get("artists")
                .and_then(|a| a.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name")?.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let duration_ms = item.get("duration_ms").and_then(|d| d.as_u64()).unwrap_or(0);
            // Pick the smallest album image so the UI stays light.
            let thumbnail_url = item
                .get("album")
                .and_then(|al| al.get("images"))
                .and_then(|v| v.as_array())
                .and_then(|imgs| imgs.last())
                .and_then(|img| img.get("url")?.as_str().map(|s| s.to_string()))
                .unwrap_or_default();
            Some(crate::discover::SearchResult {
                id: format!("spotify-{}", id),
                title: name,
                artist: artists,
                duration_secs: (duration_ms / 1000) as u32,
                thumbnail_url,
                source: "spotify".to_string(),
                url: format!("https://open.spotify.com/track/{}", id),
            })
        })
        .collect()
}

// ------- API calls ---------------------------------------------------------

async fn api_get(token: &str, url: &str) -> Result<serde_json::Value, AppError> {
    for attempt in 0..5u32 {
        let resp = reqwest::Client::new()
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| AppError::Settings(format!("Spotify GET failed: {}", e)))?;
        let status = resp.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let wait = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(5);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        if status.is_server_error() {
            tokio::time::sleep(Duration::from_secs(1u64 << attempt)).await;
            continue;
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Settings(format!("Spotify HTTP {}: {}", status, body)));
        }
        return resp.json().await.map_err(|e| AppError::Settings(e.to_string()));
    }
    Err(AppError::Settings(format!("Spotify GET {} exhausted retries", url)))
}

/// Extract a playlist ID from any of: raw ID, open.spotify.com URL, or `spotify:playlist:` URI.
fn parse_playlist_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    for prefix in [
        "https://open.spotify.com/playlist/",
        "http://open.spotify.com/playlist/",
        "spotify:playlist:",
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            let id = rest.split(['?', '/']).next()?.to_string();
            return (!id.is_empty()).then_some(id);
        }
    }
    // Plain 22-char base62 ID.
    if raw.len() == 22 && raw.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(raw.to_string());
    }
    None
}

/// Same shape as `parse_playlist_id` but for single-track URLs.
fn parse_track_id(raw: &str) -> Option<String> {
    let raw = raw.trim();
    for prefix in [
        "https://open.spotify.com/track/",
        "http://open.spotify.com/track/",
        "spotify:track:",
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            let id = rest.split(['?', '/']).next()?.to_string();
            return (!id.is_empty()).then_some(id);
        }
    }
    None
}

fn flatten_track(item: &serde_json::Value) -> Option<SpotifyTrack> {
    let t = item.get("track").unwrap_or(item);
    let id = t.get("id")?.as_str()?.to_string();
    let artists = t
        .get("artists")?
        .as_array()?
        .iter()
        .filter_map(|a| a.get("name").and_then(|v| v.as_str()).map(String::from))
        .collect();
    Some(SpotifyTrack {
        id,
        name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        artists,
        album: t
            .get("album")
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        isrc: t
            .get("external_ids")
            .and_then(|ids| ids.get("isrc"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from),
        duration_ms: t.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// Fetch a single Spotify track and wrap it in a synthetic 1-track playlist
/// so the frontend's preview + match + download pipeline can consume it as-is.
pub async fn fetch_track(app: &AppHandle, raw_url: &str) -> Result<SpotifyPlaylist, AppError> {
    let id = parse_track_id(raw_url)
        .ok_or_else(|| AppError::InvalidUrl(format!("Not a Spotify track URL: {}", raw_url)))?;

    let token = ensure_token(app).await?;
    let data = api_get(&token, &format!("{}/tracks/{}", API_BASE, id)).await?;
    let track = flatten_track(&data)
        .ok_or_else(|| AppError::Settings("Spotify /tracks/{id} returned unexpected shape".into()))?;

    let playlist_url = data
        .get("external_urls")
        .and_then(|u| u.get("spotify"))
        .and_then(|v| v.as_str())
        .unwrap_or(raw_url)
        .to_string();

    // Reuse the playlist shape so the frontend preview doesn't need a second
    // codepath, but set `name` + `owner` to the track's own title + artist
    // so the modal header reads naturally ("Track Title" / "Artist Name")
    // instead of as a fake playlist.
    Ok(SpotifyPlaylist {
        id: format!("track:{}", track.id),
        name: track.name.clone(),
        owner: track.artists.join(", "),
        playlist_url,
        tracks: vec![track],
    })
}

pub async fn fetch_playlist(app: &AppHandle, raw_url: &str) -> Result<SpotifyPlaylist, AppError> {
    let id = parse_playlist_id(raw_url)
        .ok_or_else(|| AppError::InvalidUrl(format!("Not a Spotify playlist URL: {}", raw_url)))?;

    let token = ensure_token(app).await?;

    // Playlist metadata.
    let meta = api_get(
        &token,
        &format!(
            "{}/playlists/{}?fields=id,name,owner(display_name,id),external_urls",
            API_BASE, id
        ),
    )
    .await?;

    let name = meta.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let owner = meta
        .get("owner")
        .and_then(|o| o.get("display_name").or_else(|| o.get("id")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let playlist_url = meta
        .get("external_urls")
        .and_then(|u| u.get("spotify"))
        .and_then(|v| v.as_str())
        .unwrap_or(raw_url)
        .to_string();

    // Paginated track list. Fields match the Python reference.
    let fields = "next,items(track(id,name,duration_ms,external_ids,artists(name),album(name)))";
    let mut tracks: Vec<SpotifyTrack> = Vec::new();
    let mut next_url = format!(
        "{}/playlists/{}/tracks?limit=100&fields={}",
        API_BASE,
        id,
        urlencoding::encode(fields)
    );
    loop {
        let page = api_get(&token, &next_url).await?;
        if let Some(items) = page.get("items").and_then(|v| v.as_array()) {
            for it in items {
                if let Some(t) = flatten_track(it) {
                    tracks.push(t);
                }
            }
        }
        match page.get("next").and_then(|v| v.as_str()) {
            Some(n) if !n.is_empty() => next_url = n.to_string(),
            _ => break,
        }
    }

    Ok(SpotifyPlaylist { id, name, owner, playlist_url, tracks })
}

// ------- command entry points (called from lib.rs) -------------------------

pub async fn spotify_login_cmd(app: AppHandle) -> Result<SpotifyUser, AppError> {
    let token = ensure_token(&app).await?;
    let me = api_get(&token, &format!("{}/me", API_BASE)).await?;
    let _ = app.emit("spotify-auth-changed", true);
    Ok(SpotifyUser {
        id: me.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        display_name: me
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

pub async fn spotify_auth_status_cmd(app: AppHandle) -> Result<Option<SpotifyUser>, AppError> {
    // Only return Some if we have a valid/refreshable cached token AND the /me
    // call succeeds. Don't launch the interactive flow here.
    let Some(cached) = load_cached_token(&app) else { return Ok(None) };
    let token = if cached.expired() {
        let Ok((id, secret)) = client_creds(&app) else { return Ok(None) };
        match refresh_token(&id, &secret, &cached).await {
            Ok(new) => {
                let _ = save_cached_token(&app, &new);
                new.access_token
            }
            Err(_) => return Ok(None),
        }
    } else {
        cached.access_token
    };
    match api_get(&token, &format!("{}/me", API_BASE)).await {
        Ok(me) => Ok(Some(SpotifyUser {
            id: me.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            display_name: me
                .get("display_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })),
        Err(_) => Ok(None),
    }
}

pub fn spotify_logout_cmd(app: AppHandle) -> Result<(), AppError> {
    clear_cached_token(&app)?;
    let _ = app.emit("spotify-auth-changed", false);
    Ok(())
}

pub async fn spotify_fetch_playlist_cmd(
    app: AppHandle,
    url: String,
) -> Result<SpotifyPlaylist, AppError> {
    fetch_playlist(&app, &url).await
}

pub async fn spotify_fetch_track_cmd(
    app: AppHandle,
    url: String,
) -> Result<SpotifyPlaylist, AppError> {
    fetch_track(&app, &url).await
}

/// Detect whether a URL looks like a Spotify playlist — used so the frontend
/// can branch before invoking the full fetch command.
pub fn is_spotify_playlist_url(url: &str) -> bool {
    (url.contains("spotify.com/playlist/") || url.starts_with("spotify:playlist:"))
        && parse_playlist_id(url).is_some()
}

pub fn is_spotify_track_url(url: &str) -> bool {
    (url.contains("spotify.com/track/") || url.starts_with("spotify:track:"))
        && parse_track_id(url).is_some()
}

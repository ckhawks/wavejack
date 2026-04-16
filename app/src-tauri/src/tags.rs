// tags.rs — Last.fm tag fetching with alias normalization and rate limiting.

use crate::error::AppError;
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::time::{Duration, Instant};

/// Minimum interval between Last.fm API calls (~5 req/sec).
const RATE_LIMIT_MS: u64 = 210;

/// Rate limiter for Last.fm tag requests.
pub struct TagRateLimiter {
    last_call: tokio::sync::Mutex<Instant>,
}

impl TagRateLimiter {
    pub fn new() -> Self {
        Self {
            last_call: tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(1)),
        }
    }

    pub async fn wait(&self) {
        let mut last = self.last_call.lock().await;
        let elapsed = last.elapsed();
        let interval = Duration::from_millis(RATE_LIMIT_MS);
        if elapsed < interval {
            tokio::time::sleep(interval - elapsed).await;
        }
        *last = Instant::now();
    }
}

/// Canonical alias map: maps lowercase variants to the preferred display name.
static TAG_ALIASES: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let pairs: &[(&str, &str)] = &[
        // Drum and Bass
        ("dnb", "Drum and Bass"), ("d&b", "Drum and Bass"), ("drum & bass", "Drum and Bass"),
        ("drum n bass", "Drum and Bass"), ("drumnbass", "Drum and Bass"),
        ("drum and bass", "Drum and Bass"), ("liquid dnb", "Liquid Drum and Bass"),
        ("liquid drum and bass", "Liquid Drum and Bass"),
        // UK Garage
        ("ukg", "UK Garage"), ("uk garage", "UK Garage"), ("garage", "UK Garage"),
        ("2-step", "2-Step Garage"), ("2step", "2-Step Garage"), ("2 step", "2-Step Garage"),
        // Grime
        ("grime", "Grime"),
        // Dubstep
        ("dubstep", "Dubstep"), ("brostep", "Brostep"),
        // House
        ("house", "House"), ("deep house", "Deep House"), ("tech house", "Tech House"),
        ("progressive house", "Progressive House"), ("acid house", "Acid House"),
        ("future house", "Future House"), ("tropical house", "Tropical House"),
        // Techno
        ("techno", "Techno"), ("minimal techno", "Minimal Techno"),
        ("detroit techno", "Detroit Techno"), ("hard techno", "Hard Techno"),
        // Trance
        ("trance", "Trance"), ("psytrance", "Psytrance"), ("psy trance", "Psytrance"),
        ("progressive trance", "Progressive Trance"), ("uplifting trance", "Uplifting Trance"),
        // IDM / Experimental
        ("idm", "IDM"), ("intelligent dance music", "IDM"),
        ("experimental", "Experimental"), ("glitch", "Glitch"),
        // Ambient
        ("ambient", "Ambient"), ("dark ambient", "Dark Ambient"),
        ("ambient electronic", "Ambient"),
        // Hip-Hop / Rap
        ("hip-hop", "Hip-Hop"), ("hiphop", "Hip-Hop"), ("hip hop", "Hip-Hop"),
        ("rap", "Rap"), ("trap", "Trap"), ("boom bap", "Boom Bap"),
        // R&B / Soul
        ("rnb", "R&B"), ("r&b", "R&B"), ("r and b", "R&B"),
        ("soul", "Soul"), ("neo-soul", "Neo-Soul"), ("neo soul", "Neo-Soul"),
        // Lo-Fi
        ("lo-fi", "Lo-Fi"), ("lofi", "Lo-Fi"), ("lo fi", "Lo-Fi"),
        ("lo-fi hip hop", "Lo-Fi Hip-Hop"), ("lofi hip hop", "Lo-Fi Hip-Hop"),
        // Pop
        ("pop", "Pop"), ("synthpop", "Synth-Pop"), ("synth-pop", "Synth-Pop"),
        ("synth pop", "Synth-Pop"), ("indie pop", "Indie Pop"),
        ("dream pop", "Dream Pop"), ("electropop", "Electropop"),
        ("art pop", "Art Pop"), ("k-pop", "K-Pop"), ("kpop", "K-Pop"),
        // Rock
        ("rock", "Rock"), ("indie rock", "Indie Rock"), ("alt-rock", "Alternative Rock"),
        ("alternative rock", "Alternative Rock"), ("alternative", "Alternative"),
        ("post-rock", "Post-Rock"), ("post rock", "Post-Rock"),
        ("shoegaze", "Shoegaze"), ("math rock", "Math Rock"),
        ("psychedelic rock", "Psychedelic Rock"), ("psych rock", "Psychedelic Rock"),
        ("punk", "Punk"), ("post-punk", "Post-Punk"), ("post punk", "Post-Punk"),
        // Metal
        ("metal", "Metal"), ("heavy metal", "Heavy Metal"),
        ("death metal", "Death Metal"), ("black metal", "Black Metal"),
        // Jazz
        ("jazz", "Jazz"), ("nu jazz", "Nu Jazz"), ("jazz fusion", "Jazz Fusion"),
        ("acid jazz", "Acid Jazz"),
        // Electronic broad
        ("electronic", "Electronic"), ("electronica", "Electronic"),
        ("edm", "EDM"),
        // Bass music
        ("bass", "Bass Music"), ("bass music", "Bass Music"),
        ("future bass", "Future Bass"), ("uk bass", "UK Bass"),
        ("wave", "Wave"),
        // Funk / Disco
        ("funk", "Funk"), ("disco", "Disco"), ("nu-disco", "Nu-Disco"),
        ("nu disco", "Nu-Disco"),
        // Reggae / Dub
        ("reggae", "Reggae"), ("dub", "Dub"), ("dancehall", "Dancehall"),
        // Classical
        ("classical", "Classical"), ("orchestral", "Orchestral"),
        ("soundtrack", "Soundtrack"), ("ost", "Soundtrack"),
        // Country / Folk
        ("country", "Country"), ("folk", "Folk"), ("indie folk", "Indie Folk"),
        // Downtempo / Chillout
        ("downtempo", "Downtempo"), ("chillout", "Chillout"), ("chill-out", "Chillout"),
        ("chillwave", "Chillwave"), ("chill", "Chillout"),
        // Misc
        ("singer-songwriter", "Singer-Songwriter"), ("singer songwriter", "Singer-Songwriter"),
        ("vaporwave", "Vaporwave"), ("future funk", "Future Funk"),
        ("breakbeat", "Breakbeat"), ("breaks", "Breakbeat"),
        ("jungle", "Jungle"), ("footwork", "Footwork"), ("juke", "Juke"),
        ("garage rock", "Garage Rock"), ("grunge", "Grunge"),
    ];
    let mut map = HashMap::with_capacity(pairs.len());
    for &(alias, canonical) in pairs {
        map.insert(alias, canonical);
    }
    map
});

/// Normalize a raw Last.fm tag to its canonical form.
pub fn normalize_tag(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    if let Some(&canonical) = TAG_ALIASES.get(lower.as_str()) {
        return canonical.to_string();
    }
    // Title-case if no alias match
    lower
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => {
                    let upper: String = c.to_uppercase().collect();
                    upper + chars.as_str()
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Fetch tags for a track from Last.fm, merging track and artist tags.
/// Returns normalized (tag_name, weight) pairs, sorted by weight descending.
pub async fn fetch_tags_for_track(
    api_key: &str,
    artist: &str,
    title: &str,
    rate_limiter: &TagRateLimiter,
) -> Result<Vec<(String, i32)>, AppError> {
    let mut tag_scores: HashMap<String, i32> = HashMap::new();

    // 1. track.getTopTags (most specific)
    rate_limiter.wait().await;
    if let Ok(tags) = fetch_lastfm_tags(api_key, "track.getTopTags", artist, Some(title)).await {
        for (name, weight) in tags {
            let norm = normalize_tag(&name);
            let entry = tag_scores.entry(norm).or_insert(0);
            *entry = (*entry).max(weight);
        }
    }

    // 2. artist.getTopTags (broader fallback)
    rate_limiter.wait().await;
    if let Ok(tags) = fetch_lastfm_tags(api_key, "artist.getTopTags", artist, None).await {
        for (name, weight) in tags {
            let norm = normalize_tag(&name);
            // Artist tags get lower priority if track tags already present
            let entry = tag_scores.entry(norm).or_insert(0);
            if *entry == 0 {
                *entry = weight / 2; // halve artist-level weights
            }
        }
    }

    // Sort by weight, take top 10
    let mut result: Vec<(String, i32)> = tag_scores.into_iter().collect();
    result.sort_by(|a, b| b.1.cmp(&a.1));
    result.truncate(10);

    Ok(result)
}

/// Call a Last.fm tag API method and parse the response.
async fn fetch_lastfm_tags(
    api_key: &str,
    method: &str,
    artist: &str,
    track: Option<&str>,
) -> Result<Vec<(String, i32)>, AppError> {
    let mut url = format!(
        "https://ws.audioscrobbler.com/2.0/?method={}&artist={}&api_key={}&format=json",
        method,
        urlencoding::encode(artist),
        urlencoding::encode(api_key),
    );
    if let Some(title) = track {
        url.push_str(&format!("&track={}", urlencoding::encode(title)));
    }

    let resp = reqwest::get(&url)
        .await
        .map_err(|e| AppError::LastFmFailed(format!("Request failed: {}", e)))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::LastFmFailed(format!("Invalid JSON: {}", e)))?;

    // Last.fm wraps results in "toptags" → "tag" array
    let tags = json["toptags"]["tag"]
        .as_array()
        .or_else(|| json["tag"].as_array()); // artist.getTopTags uses different nesting

    let tags = match tags {
        Some(arr) => arr,
        None => return Ok(Vec::new()),
    };

    let results: Vec<(String, i32)> = tags
        .iter()
        .filter_map(|t| {
            let name = t["name"].as_str()?.to_string();
            let count = t["count"]
                .as_i64()
                .or_else(|| t["count"].as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(0) as i32;
            if name.is_empty() || count == 0 {
                return None;
            }
            Some((name, count))
        })
        .collect();

    Ok(results)
}

# Discovery

Graph-traversal discovery strategies that use the user's existing library as the seed signal, rather than opaque algorithmic recommendations.

## Core Idea

Artists and tracks the user already has are a stronger signal than generic "people who listened to X" recommendations. Traverse the graph outward from what's already loved, and surface candidates with **provenance** — show *why* each suggestion was made.

## Expansion Paths

### 1. Same-Artist Tracks

Pull the full discography of artists already in the library.

- **Sources:** SoundCloud, Bandcamp, YouTube Topic channels, MusicBrainz release groups.
- **Signal strength:** low-to-medium — user probably already has the popular tracks.
- **Best for:** completionism, finding B-sides / unreleased tracks / remixes.
- **Cost:** cheap. API calls are linear in # of library artists.

### 2. Playlists Containing Library Tracks (highest ROI)

Find public playlists that already contain tracks from the user's library, then surface the *other* tracks in those playlists.

**Why this works:**
- A playlist curated by a human who independently chose even one of your tracks has demonstrated some taste alignment.
- A playlist containing **15** of your tracks is a goldmine — that curator's taste is heavily correlated with yours.

**Ranking:**
- **Overlap score:** # of user's tracks appearing in the playlist.
- **Overlap ratio:** overlap / total playlist size (a 500-track megalist with 5 overlaps ≠ a 30-track playlist with 5 overlaps).
- **Playlist recency:** recently updated playlists are usually actively curated.

**Filters to avoid noise:**
- Exclude mega-playlists (e.g. >200 tracks or >10k followers) — usually generic "TOP HITS" spam.
- Exclude playlists flagged as auto-generated.
- Minimum overlap threshold (e.g. ≥2 tracks) before considering.

**Sources with playlist-membership APIs:**
- **SoundCloud:** `/tracks/{id}/playlists` — works, but rate-limited.
- **Spotify:** no public API for "playlists containing this track" (user would have to auth and we'd be limited to their own playlists).
- **YouTube:** no native concept, but community playlists exist.
- **Bandcamp:** no equivalent (their model is fan collections — analogous but harder to scrape).

### 3. Artist Likes & Reposts

Artists' own "likes" feeds are often hand-picked taste-making content — DJs especially use this to boost peers and surface unreleased material.

- **Likes:** high signal, usually curated.
- **Reposts:** similar but noisier (sometimes promotional).
- **Sources:** SoundCloud has this natively (`/users/{id}/likes`). Bandcamp has fan wishlists.

## Data Model

Cache every discovered candidate with full provenance so we can explain suggestions and debug bad ones.

```
candidate_track:
  - track_id (external source ID)
  - source (soundcloud | bandcamp | youtube | ...)
  - title, artist, duration, url
  - discovered_at

candidate_signal:
  - candidate_track_id
  - signal_type (same_artist | playlist_overlap | artist_like | artist_repost)
  - source_entity_id  (playlist ID, artist ID, etc.)
  - weight            (overlap score, like count, etc.)
  - discovered_at
```

A single candidate can have many signals (found via artist likes AND in 3 playlists). Aggregate score = weighted sum.

## Ranking

Each candidate gets a composite score from its signals:

- **Artist overlap:** # of user's artists associated with this candidate's artist (via shared playlist membership, collaboration, label, etc.).
- **Playlist co-occurrence:** sum of overlap scores across all playlists containing this track.
- **Artist-like weight:** boost if liked by an artist already in the user's library.
- **Novelty penalty:** down-weight if already played/dismissed.
- **Library dedup:** hard-filter anything already in the library (by chromaprint once available; artist+title fuzzy for v1).

## UI

**Discover feed with transparent provenance:**

- Each suggestion shows **why**: "Found in 4 playlists with your tracks", "Liked by [Artist X]", "Same artist as [Track Y] in your library".
- Click-through to the source playlist/artist page.
- One-click actions: add to library (triggers download), dismiss (never show again), save for later.
- Filter by source signal type — "show me only artist-like discoveries".

## Rate Limiting & Caching

SoundCloud's API has been progressively tightening. Need to be a good citizen:

- **Cache aggressively.** Store API responses with a TTL (playlists: 7 days; artist likes: 24h; same-artist: 30 days).
- **Background-scan incrementally.** Don't blast through every library artist on startup — queue a few per hour.
- **Respect rate limits.** Exponential backoff on 429s; pause the discovery worker for hours if needed.
- **Budget per run.** Configurable daily API call cap so the user doesn't burn through quota silently.

## Reality Check: API Feasibility

Not all three paths are equally viable. Ship the reliable ones first and treat SC playlist-overlap as best-effort.

### Reliable (ship these first)

- **Same-artist tracks** — SoundCloud, Bandcamp, YouTube, MusicBrainz all expose artist discographies via stable APIs. No risk.
- **Artist likes** — SoundCloud's `/users/{id}/likes` works for public profiles without authentication. Stable for years.
- **MusicBrainz release groups** — free, documented, rock-solid. Good for finding B-sides, remixes, and alternate versions.
- **Last.fm similar artists** — algorithmic, not graph-based, but free and stable. Good fallback for cold-start libraries.

### Best-effort (will break periodically)

- **SoundCloud playlist overlap** — the feature with the highest signal, but the least reliable to build on:
  - SC stopped issuing new API keys around 2020. No official path for new apps.
  - Current workaround: scrape the web client's internal API using a `client_id` extracted from their JS. Libraries like `soundcloud-lib` and yt-dlp's SC extractor do this.
  - `client_id` rotates every few months — code breaks until patched.
  - Rate limits are aggressive and unpublished; expect soft IP bans if not careful.
  - SC has been adding Cloudflare challenges and request signing over time.
  - **Verdict:** works for personal use with a patient cache. Does not scale to many users without constant maintenance.

### Not viable

- **Spotify** — no public API for "playlists containing this track"; user-auth would only see their own playlists. Skip.
- **Bandcamp playlist-containing-track** — doesn't exist as a concept. Fan wishlists are analogous but require scraping and different modeling.

### Degradation Strategy

Design the discovery feed so it works even if SC scraping is broken:

- Mark SC playlist-overlap as a feature that "may be temporarily unavailable" in the UI.
- When SC scraping fails, fall back silently to same-artist + artist-likes + MusicBrainz + Last.fm sources.
- Queue failed SC requests for retry rather than dropping them.
- Surface a status indicator in settings showing which discovery sources are currently healthy.

## Tradeoffs / Open Questions

- **SC API access** — do we use the public endpoints (fragile, undocumented) or require user OAuth? OAuth gives higher limits but adds friction.
- **Bandcamp** has no playlist-membership API, so path #2 is SC-only for now. Fan wishlists could be scraped but would need a different model.
- **Cold start** — a tiny library (<20 tracks) won't surface much via overlap. Fall back to same-artist + artist-likes until the seed set grows.
- **Echo chamber risk** — pure graph traversal reinforces existing taste. Worth adding an occasional "wildcard" slot (e.g. tracks from *playlists* that overlap, but by artists not in your library yet).

## Future: Combine with Local Similarity

Once we have chromaprint + audio embeddings for the local library, we can:
- Score discovery candidates by audio similarity to the user's library, not just social-graph signals.
- Filter out "artist match but wrong subgenre" mismatches (e.g. an artist who does both ambient and techno — only suggest the subgenre you actually listen to).

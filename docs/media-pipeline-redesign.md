# Media Pipeline Redesign — Design Plan

Status: **draft for review** · Owner: ckhawks · Scope: download → post-process → identity → library → playback

This is a plan, not a spec. It captures the current system accurately, names the
structural problems, proposes a target architecture, and stages a migration so we
never do a big-bang rewrite. Nothing here is committed to yet — read, argue, edit.

---

## 1. The symptom vs. the disease

The trigger for this was small: the Downloads panel shows a blank artist while the
Library shows it correctly. But that bug is a *symptom*. The disease is that the
same song exists as several unrelated records with different identities and
independently-maintained copies of its metadata, and the code reconciles them with
heuristics ("split the title on ` - `", "backfill the DB field if it's empty") instead
of deriving everything from one source of truth.

Every fragile area you named — multiple download paths, multiple post-processing,
file formats, playlist vs single, spotify→tidal, soundcloud→tidal — is a facet of
that same root cause. Fix the identity + single-source-of-truth model and most of
these collapse into one code path.

---

## 2. Root cause in one picture

**Four incompatible identity schemes for a thing that is all "a track":**

| Concept            | Table             | Identity key        | Kind                       |
| ------------------ | ----------------- | ------------------- | -------------------------- |
| A download job     | `downloads`       | `id`                | random UUID (per job)      |
| A library file     | `library_tracks`  | `path`              | absolute file path         |
| Playlist member    | `playlist_tracks` | `track_path`        | file path → library        |
| Tag assignment     | `track_tags`      | `track_path`        | file path → library        |
| A feed video       | `feed_items`      | `video_id`          | provider (YouTube) id      |
| A discover item    | (frontend only)   | `crypto.randomUUID` | ephemeral                  |

There is **no link** between `downloads.id` and `library_tracks.path` except string
equality on `file_path` (`database.rs:407`). A downloaded-then-scanned song is two
rows with two identities and two metadata copies. Rename the file and the library
side cascades but the download row's `file_path` goes stale.

**The same metadata lives in ~5 layers, each a copy:**

1. Embedded file tags (real source of truth; the Library reads these).
2. `library_tracks` columns + `cover_art` BLOB (cache of #1, can drift on external edit).
3. `downloads` columns (`title/artist/album/format`) — written blank, backfilled at
   read time only if empty (`lib.rs:385-401`).
4. Event payloads (`DownloadStatusEvent`, `DownloadEnrichedEvent`) — partial snapshots.
5. Frontend stores — `DownloadItem`, `LibraryTrack`, `PlayerTrack`, `DiscoverItem` — each
   an independent in-memory copy with its own id scheme. `useDownloadEvents` even does a
   *third* artist/title derivation by splitting on ` - ` (`useDownloadEvents.ts:21-28`).

Consequence: `apply_metadata` updates `downloads` + file but not `library_tracks`; a
library edit updates `library_tracks` + file but not `downloads`; a `PlayerTrack`
snapshot goes stale after either. Cover art is stored/derived three different ways.

---

## 3. Current-state map (grounded, condensed)

### 3.1 Six acquisition paths, each with its own post-processing

| # | Path                    | Tool           | Post-processing                                              | DB write |
| - | ----------------------- | -------------- | ----------------------------------------------------------- | -------- |
| 1 | URL download            | yt-dlp→cobalt  | fmt select, WAV→FLAC (SC only), ext-fix, cover embed, probe | `build_download_record` |
| 2 | Tidal matched download  | tidal-dl-ng    | ext-fix, cover *read-back*, probe (+size/dur fallback)      | `build_download_record` (cover dropped, format hardcoded `flac`) |
| 3 | ffmpeg audio extract    | ffmpeg         | none (no cover, no tags, no ext-fix, no probe)              | hand-built `DownloadRecord` |
| 4 | Discover keep           | none (fs move) | none                                                        | hand-built `DownloadRecord` (format hardcoded `mp3`) |
| 5 | Preview producers        | tidal-dl-ng / yt-dlp | download to preview dir                                | none (transient) |
| 6 | Spotify/SC → Tidal      | funnels to #2  | (see #2)                                                     | (see #2) |

**Duplication inventory (things implemented N times):**

- **Cover art: 3+ ways.** yt-dlp embeds via lofty *and* stores base64 in the row;
  tidal reads it back for the event but stores empty in the row; cobalt/ffmpeg/discover
  do nothing; a separate on-demand system exists for library tracks; and
  `get_download_history` re-reads it live to paper over the blanks.
- **`download-enriched` event:** emitted by paths 1 & 2 only; cobalt, ffmpeg, discover
  never emit it — so audio_format/bitrate silently missing there.
- **`format` field lies:** tidal hardcodes `flac` (`lib.rs:2164`), ffmpeg/discover
  hardcode `mp3` regardless of the real container that ext-fix/probe found.
- **DB record construction:** paths 1–2 use `build_download_record`; paths 3–4 hand-build
  the struct inline with different defaults.
- **Extension-fix + probe:** near-identical logic duplicated in `ytdlp.rs:505-567` and
  `tidal_download.rs:312-369` (tidal adds a bitrate fallback yt-dlp lacks).
- **`artist`/`album`/`cover_art_path`:** dropped on *every* path; downloaders embed them
  into the file but nothing copies them to the row.

### 3.2 Two divergent matchers

- **Spotify→Tidal** (`tidal.rs match_one`): ISRC-first (good), but the fuzzy fallback
  matches on **duration only** (`tidal.rs:660-666`) — no title/artist check at all. First
  result within ±5s wins even if it's a different song.
- **SoundCloud→Tidal** (`tidal.rs match_one_sc`): fuzzy Sørensen–Dice on title+artist with
  gates (`TITLE_MIN=0.6`, `ARTIST_MIN=0.5`, ±5s), no duration-only fallback. Much stronger.
- Two structs (`TidalMatch` vs `ScTidalMatch`), two code paths, two rigor levels for the
  same operation. Spotify search results drop ISRC, forcing a re-fetch round-trip.

### 3.3 Grouping (playlist vs single) decided in 3 places, 3 rules

- Spotify preview: `isSingleTrack ? undefined : name` (`SpotifyPlaylistPreview.tsx:228`).
- SoundCloud preview: always passes `playlist.title`, even for a synthetic 1-track DRM
  preview (`PlaylistPreview.tsx:176`).
- Direct URL download: passes no playlist title.
- Net: a single DRM SoundCloud track gets tagged with a playlist group; a single Spotify
  track does not. There is no persisted playlist/batch entity — grouping is a loose string.

### 3.4 Identity-destroying scan

`scan_folder_incremental` keys everything on full path. A moved/renamed file =
delete(old) + add(new), with **no content matching**. That silently loses `play_count`,
`last_played_at`, `first_scanned_at`, tags, waveform, and playlist membership (cascade
deletes on the old path). Only the *explicit* rename paths (metadata edit, ext-fix)
preserve identity by cascading.

### 3.5 Two disconnected Tidal credentials

Wavejack's Tidal OAuth (baked-in public "TV" creds) is used **only** for search/matching.
Actual downloads require the user to `tidal-dl-ng login` separately. Two credentials, two
failure modes, no unified status in the UI.

---

## 4. Design principles

1. **One source of truth for metadata: the file's embedded tags.** Everything else is a
   cache or a projection, never an authority.
2. **One stable identity per track that survives renames/moves.** Path is an *attribute*,
   not the identity.
3. **Separate transient job state from durable track state.** A download is a *job*; the
   song it produces is a *track*. Jobs reference tracks; jobs never own metadata.
4. **One pipeline.** Backends differ only in "how bytes land on disk." Everything after —
   normalize, tag-read, cover, upsert, emit — is a single shared finalize step.
5. **One matcher.** All provider→Tidal matching goes through one scorer using
   ISRC + title + artist + duration, with one result type.
6. **One grouping rule.** A batch (optional playlist) is an explicit entity; a single track
   is a batch of one with no group.
7. **Frontend reads from one canonical store keyed by track identity.** Views select; they
   don't hold independent snapshots.

---

## 5. Target architecture

### 5.1 Identity model

Introduce a durable **`tracks`** table with a surrogate stable `track_id` (UUID) that is
*not* the path. Renames update `path`; identity is stable.

To recognize a moved file as the same track (instead of delete+add), match on a
**content fingerprint**: cheap, stable across tag edits. Options, cheapest first:
- (a) `(size, audio-stream md5)` — hash the decoded/first-N-bytes of the *audio* stream so
  tag edits don't change it. Robust; a little I/O on scan.
- (b) A generated id written *into* a custom tag on our own downloads (like MusicBrainz
  IDs) — free for files we produce, absent for imported files (fall back to (a)).
- Recommended: **(b) for our downloads + (a) as the fallback** for externally-added files.

`tracks` also stores **provenance** for dedup and re-matching: `source_provider`,
`source_provider_id`, `isrc`. This is what lets us answer "do we already have this
Spotify/Tidal track?" without re-downloading, and powers real dedup (the thing that was
missing when the failed rows got deleted earlier).

### 5.2 Data model (target)

```
tracks
  track_id      TEXT PK        -- stable UUID, survives rename/move
  path          TEXT UNIQUE    -- current location (mutable)
  fingerprint   TEXT           -- audio-stream hash (move detection)
  title, artist, album         -- cache of embedded tags (source of truth = file)
  duration_secs, bitrate_kbps, bitrate_estimated, file_type
  cover         BLOB           -- cache of embedded picture
  isrc          TEXT           -- provenance
  source_provider, source_provider_id
  first_seen_at, mtime, size, play_count, last_played_at, waveform

download_jobs            -- transient; the "Downloads panel" model
  id            TEXT PK        -- job UUID (fine to be per-attempt)
  url, provider
  requested_quality
  status, progress, message, backend, error
  batch_id      TEXT NULL      -- → download_batches
  track_id      TEXT NULL      -- set on completion → tracks
  created_at

download_batches         -- explicit grouping (playlist OR single)
  id            TEXT PK
  kind          TEXT           -- 'single' | 'playlist'
  title         TEXT NULL      -- playlist name (null for single)
  source_provider, source_url
  created_at

playlist_tracks.track_path  → track_id   -- repoint to stable id
track_tags.track_path       → track_id   -- repoint to stable id
```

`library_tracks` folds into `tracks` (a library file is just a track whose path is under a
watched folder). `downloads` splits into `download_jobs` (+ optional `download_batches`)
with **no metadata columns** — the panel joins `download_jobs.track_id → tracks` for
display.

### 5.3 The one pipeline

Every acquisition path ends by calling a single function:

```
finalize_acquired_file(path, provenance) -> Track
  1. fix_extension            (container truth)
  2. normalize container      (optional: WAV/AIFF → FLAC, one place)
  3. ensure cover embedded    (embed if missing; one implementation)
  4. read canonical tags      (lofty: title/artist/album/cover/duration/bitrate/type)
  5. compute fingerprint
  6. upsert tracks row (by fingerprint, else path); attach provenance
  7. emit ONE `track-updated` event (id + full metadata)
```

Backends (yt-dlp, cobalt, tidal-dl-ng, ffmpeg, fs-move) only produce a file on disk and a
`provenance` struct. All the format/cover/probe/DB logic that's currently duplicated 2–6×
lives here once. This single step kills §3.1's entire duplication inventory and the
"format field lies" / "enriched event missing" / "cover 3 ways" bugs at once.

### 5.4 Unified matcher

One module, one entry point, one result type:

```
match_to_tidal(TrackQuery{ title, artists, isrc?, duration }) -> Match{ tidal_id, confidence, reason }
  - ISRC exact (openapi + v1 verify with duration) when isrc present
  - else fuzzy: Dice(title) + Dice(artist) + duration gate  (the SoundCloud scorer)
  - NEVER duration-only
```

Spotify and SoundCloud both build a `TrackQuery` and call it. Delete `match_one`'s
duration-only fallback. Carry ISRC through Spotify search results so there's no re-fetch.

### 5.5 Unified grouping

A user action creates one `download_batch` (kind=single or playlist) and N
`download_jobs`. Single track = batch of one, `kind=single`, `title=null` — for *every*
provider. The panel groups by `batch_id`. No more three-rules divergence.

### 5.6 Frontend canonical store

One `trackStore` keyed by `track_id` holds canonical display metadata. `PlayerTrack`,
downloads rows, library rows, discover items all reference a `track_id` and *select* from
the store rather than freezing a copy. Edits update one place and every view re-renders.
Transient job state (progress/status) stays in a `downloadJobStore` keyed by job id, joined
to `trackStore` for display.

### 5.7 Tidal auth (separate track)

Surface `tidal-dl-ng login` status in-app; long-term, evaluate whether one credential can
serve both search and download. Low priority relative to the identity work, but it's a real
papercut worth a card.

---

## 6. Migration — staged, no big bang

Each stage is independently shippable and leaves the app working. Ordered by
risk-adjusted value.

**Stage 0 — Tactical stops (DONE / in progress this session).**
`get_download_history` backfills cover + tags from the file; cover carried on Tidal
completion; thumbnail size. Keep — they make the panel correct today with zero schema risk.

**Stage 1 — Extract the one pipeline (no schema change).** Introduce
`finalize_acquired_file` and route all six paths through it. Removes the biggest
duplication, fixes format-lies / missing-enriched / cover-3-ways immediately. *Highest
value-to-risk.* Start here.

**Stage 2 — `tracks` table + fingerprint.** Add the table, populate from scan + finalize,
compute fingerprints. Keep `library_tracks` as a compatibility view during transition.

**Stage 3 — Rename/move preservation.** Scan matches by fingerprint before delete+add;
repoint `playlist_tracks`/`track_tags` to `track_id`. Stops silent loss of play_count/tags/
playlist membership on move.

**Stage 4 — Downloads become jobs.** Split `downloads` → `download_jobs` (+ `download_batches`),
drop metadata columns, panel joins to `tracks`. Kills the download/library drift entirely.

**Stage 5 — Unify matcher + grouping.** One matcher, one result type, one batch/grouping
rule across providers. Carry ISRC through Spotify search.

**Stage 6 — Frontend canonical store.** `trackStore` keyed by `track_id`; player/downloads/
library/discover select from it. Removes the last snapshot-drift layer.

**Stage 7 — Tidal auth reconciliation.** Surface login status; evaluate single-credential.

Dependency notes: 1 is standalone. 2 precedes 3/4. 5 depends on nothing structural (can slot
after 1). 6 wants 4 done. 7 is fully independent.

---

## 7. Decisions needed before Stage 2

These are the forks where I want your call (not blocking Stage 1):

1. **Fingerprint strategy** — audio-stream hash (works for imported files, some scan I/O)
   vs. embedded-id-for-our-downloads + hash fallback. Recommendation: the hybrid.
2. **Do we keep `downloads` as history forever, or GC completed jobs** once a `track` exists?
   (Affects whether the panel is "recent activity" or "permanent log".)
3. **Dedup policy** — when a match/URL already maps to an existing `track` (by provenance or
   fingerprint), do we skip, re-download, or offer a choice? (This is the feature that was
   missing when the failed rows got deleted.)
4. **One DB or split?** Everything is in `download_history.db` today. Fine to keep, but the
   name is now a lie; consider renaming to `wavejack.db` during Stage 2.

---

## 8. What this buys us

- The artist/cover/format bugs stop being a class of bug — there's one place to be right.
- Real dedup becomes possible (provenance + fingerprint).
- Moves/renames stop nuking play counts, tags, and playlist membership.
- One matcher means Spotify matches get as good as SoundCloud's.
- Adding a new provider or backend = implement "produce a file + provenance," nothing else.
- The Downloads panel and Library can never disagree again, because they read the same track.
```

# Agent-Verifiability Audit

An assessment of how well the wavejack codebase supports safe, automated
verification of AI-generated (or any) changes — independent of who wrote the
code. The report has two parts:

1. **Structural audit** — seven verifiability dimensions, each rated per layer.
2. **`app/` fragility report** — concrete, ranked defects in the Tauri app
   (the most fragile half), with file:line references and failure scenarios.

> **Overriding finding:** there are **zero automated tests and zero runtime
> assertions anywhere in the repo** — no `#[cfg(test)]`, no `*.test.ts` /
> `*.spec.ts`, no Vitest or Playwright config or dependency — despite
> `CLAUDE.md` mandating "Rust: `#[cfg(test)]` + `tests/`; TS: Vitest +
> Playwright." Every rating below is about the architecture's *capacity* to
> support verification, because none is currently exercised.

The three layers differ sharply. Roughly: **`api/` (the room server) is the
most verifiable, the Rust backend the least.**

---

## Part 1 — Structural audit

### 1. Locality of Effect — Low (Rust) / Medium-Low (frontend) / Medium (API)

The Rust backend routes almost everything through one global
`Mutex<Connection>` pulled via `app.state::<Database>()` at ~40 call sites, so
all DB work is globally serialized and a single panic-while-locked poisons the
mutex process-wide. The frontend has a module-scope WebSocket singleton and ~36
cross-store `getState()` calls that reach across store boundaries. The API is
the bright spot: state is dependency-injected once in `index.ts:28-30` into
classes with private state, so fresh instances are constructible in a harness —
though room membership is duplicated across four Maps kept in sync only by
convention.

- **Rust:** `database.rs:504-528` maps 12 columns by **positional index**
  (`row.get(6)?` = cover_art, `row.get(11)?` = bitrate_estimated). The indices
  line up today, but any `SELECT`/schema reorder is silent data corruption with
  no compile signal. Migrations are unversioned idempotent `ALTER TABLE … .ok()`
  calls (`database.rs:91-93`) that swallow errors on every startup.
- **Frontend:** `playerStore.ts:46-50` — the player's next/prev logic depends on
  `useDownloadStore.getState().downloads` filtered by
  `d.status === "complete" && d.format === "mp3"`; renaming a download field
  silently breaks playback.

There is no "unit of change" with provably bounded scope in the Rust or frontend
layers; the API's `RoomManager` is the closest thing.

### 2. Separation of Pure Logic from Effects — Low (Rust) / Medium (frontend) / Medium-High (API)

The API has a genuinely effect-free core: `RoomManager` (`rooms.ts`) does vote
tallying (`addReaction`), DJ rotation (`advanceDj`), and queue management with no
I/O, sockets, or timers — you can drive the entire room state machine with no
server running. The frontend has a few pure selectors (`libraryStore.ts:152`
`filteredTracks`, `feedStore.ts:98`) but most actions interleave `invoke`/WS/
cross-store effects. The Rust backend is worst: parse logic is fused with side
effects.

- **Rust anti-pattern:** `ytdlp.rs:156-253` `process_ytdlp_line` interleaves
  line-parsing with `app.emit(...)` — you cannot unit-test "does this line yield
  45.2%" without a Tauri handle. The same fusion appears in every
  Last.fm/SoundCloud fetcher (parse inlined right after `reqwest::get`).
- **Estimated testable-without-mocking-the-world:** ~10-15% (Rust), ~15-20%
  (frontend), ~near-100% of `RoomManager` (API). The one leak in the API's pure
  core is `Date.now()` called inside `rooms.ts:131`.

### 3. State Model Explicitness — Low overall

Domain state is overwhelmingly modeled as **stringly-typed flags and independent
nullable fields**, not discriminated unions, so invalid states are freely
representable. The lone strong exception is the API's client-message schema.

- **Bad:** download status is a bare `String` (`database.rs:15`) with implicit
  values `"downloading" | "complete" | "error" | "converting"`; `backend`,
  `source`, `format` are likewise raw strings compared with `if format == "mp3"`.
  In `playerStore.ts` and `roomStore.ts`, `currentTrack`/`playbackStartedAt`
  (and `connected`/`currentRoomId`/`userId`) are independent nullables —
  `isPlaying: true` with `currentTrack: null`, or `playbackStartedAt` set with
  `currentTrack: null`, are all type-valid. They're kept consistent only by
  always being cleared together (convention, not types).
- **Good:** `api/src/types.ts:100` —
  `clientMessageSchema = z.discriminatedUnion("type", [...])`, and `ws.ts:65`
  switches on the narrowed `msg.type`. This is the only place invalid input is
  structurally impossible. Note the asymmetry: **server→client** messages are
  hand-constructed with no schema (`types.ts:114` "no schema needed").

A `"Kept!"` string is even used as control flow in `discoverStore.ts:110`.

### 4. Determinism & Reproducibility — Low overall

Non-determinism is pervasive and, critically, **inline with business logic
rather than isolated behind a boundary**. Nothing could run in a replay
harness without touching real infrastructure or wall-clock time.

- **Rust:** subprocess output parsing (yt-dlp/ffmpeg/ffprobe — version-sensitive
  string matching), raw `reqwest::get`, `SystemTime::now()` embedded directly in
  DB writes (`database.rs:290`), `rand::rng().shuffle()` on discovery results
  (`discover.rs:736`), OS-dependent `read_dir` ordering, and detached
  `async_runtime::spawn` tasks.
- **Frontend:** `Math.random()` **inside playback logic** (`playerStore.ts:78`
  shuffle pick — unreproducible), `crypto.randomUUID()` for item ids (defeats
  snapshots), and wall-clock track position: `NowPlaying.tsx:30,47` compute
  `(Date.now() - playbackStartedAt)/1000` on a `setInterval`.
- **API:** `PlaybackTimer` (`playback.ts:8`) uses the real global
  `setTimeout(…, durationSeconds * 1000)` with no injected clock — it *is*
  isolated behind a class (mockable), but no scheduler seam exists.

### 5. Testability Surface — Low overall

Zero tests today. The property-testable surface exists but is small and
untouched: pure helpers like `normalize_tag` (idempotence), `split_artists`,
`sanitize_filename` (no forbidden chars), `log_bucket` (output length == bands,
values in 0..1), and `RoomManager`'s rotation/tally. Natural invariants are real
but **enforced only in comments and paired-mutation convention**, never in types,
assertions, or runtime checks.

- **Unenforced invariants:** "exactly one active DJ" and "currentDj ∈ djQueue"
  (`rooms.ts:120`, never asserted); "Library tracks use the file path as their
  id; downloads use a UUID" (`AudioPlayer.tsx:239`, comment only);
  "playbackStartedAt set iff currentTrack set" (convention).
- The Rust detached-task pattern (`start_download` returns `Ok(())` at
  `lib.rs:132` before the download runs) means a command's `Result` doesn't
  reflect the real outcome — verification must observe emitted events or the DB,
  not the return value.

### 6. Change Safety — Low-Medium (Rust) / Medium (frontend) / Medium-Low (API)

Both TS projects are `strict: true` with `noUnusedLocals`/
`noFallthroughCasesInSwitch`, and `any` is essentially absent (0 in frontend) —
the compiler is a genuine gate. Rust's ownership + `Result` propagation is real
safety. But the guarantees are heavily undercut at the boundaries.

- **`AppError` collapses distinct failures into `Io(String)`**
  (`error.rs:51-69`): `From<io::Error>`, `From<reqwest::Error>`, and
  `From<rusqlite::Error>` all map to `AppError::Io`. A network failure, DB
  corruption, and a missing file are indistinguishable at the type level *and*
  over IPC (`#[serde(tag="kind")]` reports `"Io"` for all three).
- **Untyped wire boundaries (TS):** `ws.ts:53`
  `JSON.parse(event.data) as ServerMessage` (asserted, never validated);
  `downloadStore.ts:64` `status: r.status as DownloadItem["status"]` (a bad DB
  value becomes a lying type); fetch responses cast with `as` throughout
  `roomStore.ts`.
- **Type drift is unmitigated (no codegen):** Tauri result types are snake_case
  to match Rust serde defaults (`duration_secs`, `cover_art_base64`, matching
  `library.rs:12` with no `rename_all`), while room types are camelCase. Any
  Rust field rename breaks at runtime, not compile time.
- **Silent swallowing:** 74 `let _ =` in Rust — including
  `let _ = db.upsert_library_track(...)` (`library.rs:139`), so a failed write
  during a scan is invisible while `ScanResult` still reports success. 53
  `.lock().unwrap()` create a poison-cascade risk.
- **API-specific:** many non-null `!` assertions on shared mutable state
  (`ws.ts:265`), and **rate limiting is entirely absent** despite `CLAUDE.md`
  requiring it — a single socket can flood `handleChat`/`handleReaction`, and
  `POST /upload` spawns an unbounded ffmpeg subprocess per request.

### 7. Human-Judgment Surface — Medium

Most core logic *is* objectively checkable (queue/history navigation, the 3s
`playPrev` restart threshold at `playerStore.ts:192`, seed dedup/cap, filter
selectors, WS reducer transitions). The genuinely subjective layer is narrow:
`colorThief.ts:43` dominant-color heuristics, and game-feel (framer-motion,
`SpectrogramBar`/`WaveformBar` visualizers, 60Hz progress smoothness).

- **The weakness is sandboxing:** styling is inline Tailwind class strings
  co-located with logic in every component (`AudioPlayer.tsx:288`), and
  animations are component-embedded. There is no design-token layer or file
  boundary separating "visual-only" from "logic" changes — an agent **cannot
  verify from file/diff boundaries that a change is purely cosmetic**.

### Structural risks & refactors

**Top 3 structural risks:**

1. **Silent-corruption boundaries with no compile-time signal.** Positional DB
   row mapping, `as`-cast wire/DB values, and hand-mirrored snake/camel types
   with no codegen mean a field rename compiles cleanly and fails only at
   runtime.
2. **Outcomes are invisible to the return value.** Detached-spawn +
   `AppError::Io(String)` collapse + 74 `let _ =` mean neither a caller nor a
   verifier can determine success/failure or *why* from what the code returns.
3. **Implicit, unenforceable invariants + zero test infrastructure.** Critical
   rules live only in comments and convention, with invalid states fully
   representable; non-determinism is wired inline through the logic.

**Top 3 highest-leverage refactors (effort→impact):**

1. **Add a Vitest + `#[cfg(test)]` harness and test the pure cores that already
   exist** (`RoomManager`, `resolveAdjacent`, WS reducer, selectors,
   `normalize_tag`, `log_bucket`). Lowest effort, immediate coverage.
2. **Kill type-drift and untyped boundaries with schemas/codegen** — generate TS
   types from Rust structs, replace `as`-cast wire boundaries with Zod `parse`,
   add a server→client message schema.
3. **Make state and failure explicit** — enums / discriminated unions for
   status/backend/source and player/room state; split `AppError::Io(String)`
   into `Network`/`Database`/`Filesystem`; versioned migrations + named-column
   DB reads.

---

## Part 2 — `app/` fragility report

The Tauri app (Rust backend + React frontend) is the most fragile half. Three
patterns generate almost every defect, all invisible to the compiler and
untested:

1. **Two state channels that must be hand-synced.** Playback truth lives in Rust
   (rodio sink) but is mirrored by React store flags; download truth lives in
   both live `app.emit` events *and* a separate DB write. Every `emit`/DB write
   failure is swallowed (`let _ =`).
2. **React effects racing async Tauri commands** — multiple `useEffect`s drive
   the same backend state with no ordering or cancellation.
3. **Fire-and-forget backend tasks with one narrow error channel** — a panic or
   an unexpected subprocess string produces no terminal signal, stranding UI
   state.

### Critical — data loss & unrecoverable states

**C1. Silent file overwrite on every rename → on-disk data loss.**
`update_library_track` (`lib.rs:1240`), `update_mp3_metadata` (`lib.rs:299`),
`apply_metadata_to_file` (`metadata.rs:245`), and `discover_keep` (`lib.rs:1046`)
rename to `"{Artist} - {Title}.{ext}"` via `tokio::fs::rename`, which silently
replaces an existing destination on Unix/macOS. Two files sharing artist+title
(clean rip + live version) → editing/normalizing one destroys the other, and the
DB row for the clobbered file is then rewritten away. No existence check, no
dedup suffix. *Worst defect; triggers on ordinary duplicate metadata.*

**C2. Dual audio engines can play simultaneously with no mutual exclusion.** The
main player is Rust-side state; `Layout.tsx:168` only conditionally renders
`<AudioPlayer>`, and none of its effect cleanups call `audioStop`/`audioPause`
on unmount (`AudioPlayer.tsx:112-172`). Play a library track → switch to the
Rooms tab (AudioPlayer unmounts, Rust sink keeps playing) → join a room →
`NowPlaying.tsx:34` starts an HTML `<audio>`. Two tracks play at once, and the
native one can't be stopped because its transport UI is gone.

**C3. Skipping the last discover track = stuck card pointing at a deleted file.**
`skipCurrent`/`keepCurrent` (`discoverStore.ts:151-176`) unconditionally
`discoverTrash(item.filePath)` / stop playback, but only advance `currentIndex`
when `nextIndex < queue.length`. On the last item, the file is deleted but the
index doesn't move; the "All done!" screen (`DiscoverPlayer.tsx:41`) never shows,
the card stays `status:"ready"`, and pressing Play calls `audio_load` on a
missing file. (Related: even a non-last skip races on Windows — `discoverTrash`
fires before the native `audio_stop`, which only happens later via a
store-driven effect, so the file may still be open.)

**C4. Position lost on any AudioPlayer remount.** The load effect keyed on
`[currentTrack?.id, filePath, …]` (`AudioPlayer.tsx:112`) re-runs on mount, and
`audio_load` (`audio.rs:316`) always appends the decoder from the start — no
seek-to-saved-position. Play to 1:30 → Rooms tab → back → track restarts at 0:00.

### High — races, silent failures, robustness

**H1. Two effects race `audioPlay()` around the async `audioLoad`.** On a track
change both `AudioPlayer.tsx:112` (load) and `:133` (play/pause sync) fire; the
play effect can reach Rust before the new track finishes loading, briefly
resuming the previous track (`audio_play` plays whatever `state.player` holds,
`audio.rs:334`).

**H2. Detached backend task panics strand the UI in "downloading" forever.**
`start_download` (`lib.rs:71`), `discover_preview` (`:953`), `search_preview`
(`:784/838`), `tidal_download_matched` (`:1857`), `bulk_fetch_tags` (`:1483`)
all `async_runtime::spawn` with the only error path being an `Err` arm. A panic
is swallowed by the runtime → no error event, no error DB row → the optimistic
queue entry stays "downloading" with no terminal event ever.

**H3. yt-dlp "success but no path" → unplayable record stuck at "complete".**
`download_with_ytdlp` derives `file_path` purely by string-matching stdout
(`ytdlp.rs:164-202`). yt-dlp changes these strings across versions; if unmatched
the process still exits 0 → `Ok(file_path: None)` → `lib.rs:95` writes status
`"complete"` with `""` path → `get_download_history` skips its existence check
because the path is empty (`lib.rs:365`). Shown as complete, can't play, never
flagged.

**H4. One transient network blip permanently blanks tags.** `bulk_fetch_tags`
(`lib.rs:1505`) does `Err(_) => { let _ = db.set_track_tags(path, &[]); }` — a
Last.fm 429/5xx marks `tags_fetched_at`, and `tracks_needing_tag_fetch`
(`WHERE tags_fetched_at = 0`) never returns that track again. No retry path; the
write error is itself swallowed.

**H5. Path traversal / arbitrary write from a Cobalt instance.**
`extract_filename` (`cobalt.rs:176`) trusts the download server's
`Content-Disposition` verbatim, then `cobalt.rs:105` does
`PathBuf::from(output_dir).join(&filename)`. A malicious/compromised cobalt
(user-configured, attacker-controlled content) returning `filename="../../…"` or
an absolute path escapes `output_dir` entirely. No `file_name()` clamp.

**H6. Tauri `listen` cleanup race leaks event listeners.**
`AudioPlayer.tsx:150-172` and `SpectrogramBar.tsx:33-43` store the unlisten fn
inside `.then` and call it in cleanup; if the component unmounts before
`listen(...)` resolves, the fn is still `undefined` and the listener is never
removed. Tab/player churn accumulates orphaned `audio://progress`/`spectrum`
handlers.

**H7. `playlistStore` has no request cancellation → wrong contents shown.**
`setActive`/`refresh` (`playlistStore.ts:44-80`) await `getPlaylistTracks(id)`
then blindly `set(...)`. Click playlist A then B; if A resolves last, the UI
shows B selected with A's tracks.

**H8. DB mutex: poison bricks everything, and the hot path holds the lock during
full-table base64.** Every method does `self.conn.lock().unwrap()` (~40 sites);
a panic while holding it poisons the connection for the whole app. Worse,
`get_all_library_tracks` (`database.rs:480-531`) base64-encodes every cover BLOB
*while holding the lock*, and it's called on every library open (`lib.rs:1146`),
again per playlist view (`lib.rs:1422`), and on every natural track end
(`AudioPlayer.tsx:246` `library.refresh()`).

**H9. Player↔download coupling breaks silently on shape drift.**
`downloadQueueIds` (`playerStore.ts:45`) hard-filters
`d.status === "complete" && d.format === "mp3" && d.filePath` — the next/prev
adjacency source. Rename a status value, add a format, or an item lacking
`filePath` → silently skipped or dead-ended, no error. `downloadStore.ts:62-64`
casts DB rows `as "mp4"|"mp3"`, so a bad DB value becomes a lying type feeding
this filter.

### Medium — desync, swallowed errors, timers

**M1. Room upload errors are swallowed.** `uploadTrack` (`roomStore.ts:213`)
throws inside `try/finally` with no catch, and callers (`DjQueue.tsx:28-45`)
don't catch either → unhandled rejection, `uploading` resets, DJ sees nothing on
a 400/413/duplicate.

**M2. WS payloads are `as ServerMessage`-cast, reducer has no `default`,
`currentDj` never reconciled.** `ws.ts:53` trusts arbitrary socket data;
`roomStore.ts:58-116` never validates fields — a malformed `now_playing` sets
`currentTrack` to `undefined`; an out-of-order `now_playing` after `track_ended`
resurrects a track. `now_playing.djId` is ignored, so `currentDj` can lag
reality, making `canSkip` (`NowPlaying.tsx:11`) and the upload gate
(`DjQueue.tsx:92`) wrong.

**M3. WS reconnect-suppression is dead code.** `ws.disconnect` (`ws.ts:84-90`)
sets `maxReconnectAttempts = 0` then restores `3` synchronously — it only
"works" because `onclose` is nulled first, so the guard is illusory. Also
`tryReconnect` never nulls `reconnectTimer` after firing.

**M4. `feedStore.addChannel` fires an uncancelled hardcoded 3s timer.**
`feedStore.ts:56` `setTimeout(() => reloadItems(), 3000)` — id never stored/
cleared; removing the channel within 3s still fires a stale reload, adds stack
overlapping timers, and a feed slower than 3s shows no items until manual
refresh.

**M5. `playPrev` forces `isPlaying: true` on a paused track.**
`playerStore.ts:192` — pause at 1:00, press Previous → it restarts and starts
playing. All navigation branches set `isPlaying:true`, so next/prev can never
preserve a paused state.

**M6. `keepCurrent` demotes a `ready` item back to `pending`.**
`discoverStore.ts:127` (inconsistent with `approveCurrent` which only patches the
message); a late `discover-status` event or revisit then disagrees about whether
the file exists. The stringly-typed `item.message === "Kept!"` guard (`:110`) is
the sibling smell.

**M7. Waveform/play-count writes silently no-op for non-library files → unbounded
ffmpeg recompute.** `set_library_waveform`/`record_library_play` are
`UPDATE … WHERE path = ?` (`database.rs:388/366`); files played from the
Downloads tab that aren't in a registered library folder match 0 rows, return
`Ok`, and the cache read stays empty — so `get_or_compute_waveform`
(`lib.rs:1278`) re-shells ffmpeg to decode the whole track every time.

**M8. Migrations `.ok()` can leave a stale schema that hard-fails reads later.**
`database.rs:91-223` swallows all `ALTER TABLE` errors — correct for "duplicate
column" but also for real I/O/lock failures. A skipped `bitrate_estimated` add
(`:140`) makes later `row.get(11)` (`:527`) fail with "no such column" and the
whole library load dies, with no breadcrumb.

### Lower / security hygiene

- **OAuth refresh tokens stored world-readable.** `auth_cache::save`
  (`auth_cache.rs:25`) uses `std::fs::write` (0644) for Spotify/Tidal
  access+refresh tokens; Spotify `clientSecret` is plaintext in `settings.json`.
  No `0o600`.
- **`rescan_library_for_path` dedup set wedges on a scan panic.** `static
  IN_FLIGHT` (`lib.rs:1955`) inserts before spawn, removes inside the blocking
  task; a panic before removal leaves the folder stuck forever and poisons the
  `std::sync::Mutex`. Auto-rescan silently stops until restart.
- **Tidal batch token captured once** (`tidal.rs:744`) — long playlists outrun
  token expiry; every remaining track errors with no in-loop refresh. Plus
  `reqwest::Client::new()` is rebuilt per request (new pool+TLS) across
  tidal/spotify/discover.
- **`remote.rs` token compare is non-constant-time** (`:72`) — negligible on
  loopback, noted for completeness.

### Suggested fix order

1. **C1** — existence check + dedup suffix (or `O_EXCL`) before every rename.
2. **C2 + H1 + H8/refresh** — make Rust audio the single source of truth: stop
   the native sink on AudioPlayer unmount, gate the two racing effects, drop the
   per-track-end `library.refresh()`.
3. **C3** — advance/finish the discover queue before trashing; clear
   `filePath`/`status` when a preview is deleted.
4. **H2/H3/H4** — give detached tasks a terminal-state guarantee (catch panics /
   inspect `JoinHandle`); never mark work "complete"/"fetched" without a verified
   artifact.
5. **H5 + tokens** — clamp Cobalt filenames with `file_name()`; chmod token files
   `0o600`.

The deepest structural fix, matching Part 1: collapse the mirrored player/
download state into one authoritative model and add a test harness around the
now-pure pieces (`resolveAdjacent`, status transitions, `extract_filename`).
Most of these bugs are exactly what one round of tests would have caught.

---

*Read-only audit. No behavior was changed; this document only records findings.*

# Wavejack — TODO

## Planned features

### Playlists
First-class user playlists, persisted in SQLite alongside `library_tracks`.
- Schema: `playlists(id, name, created_at, updated_at, cover_art BLOB?)` +
  `playlist_tracks(playlist_id, track_path, position)`.
- CRUD: create, rename, delete; drag-to-reorder within a playlist; add/remove
  tracks from the library tab via right-click or a "+" button per row.
- Sidebar / second-tab navigation listing playlists; clicking opens a view
  similar to `LibraryView` but limited to the playlist contents and using the
  saved order (no sort by default — playlists have intentional ordering).
- "Play playlist" pushes its tracks into `playerStore.queue` so autoplay /
  shuffle / back-forward all work the same.
- Bonus: smart playlists (filter expressions over the library — "all tracks
  played > 5 times in the last month").

### Move-file with DB integrity
Today moving an audio file outside the app silently breaks library rows and
download history (path becomes invalid, cover BLOB orphaned, play counts
stranded). Need an in-app "Move to..." action and a path-update path.
- Right-click → "Move to folder..." opens the folder picker, performs the
  filesystem move, then atomically updates `library_tracks.path`,
  `library_tracks.folder`, and any matching `downloads.file_path` rows. Keeps
  `play_count`, `first_scanned_at`, `waveform`, `cover_art` intact.
- Multi-select: move N rows in one go.
- Bonus: detect external moves on rescan — if a file is missing from one
  folder but a file with the same `(mtime, size, duration_secs, bitrate_kbps)`
  fingerprint appears in another scanned folder, treat it as a move and
  preserve the row instead of delete+reinsert.

### Search-and-download from the Downloads tab
Right now you have to paste a URL. Add a search bar that hits YouTube +
SoundCloud and lists results inline.
- Reuse the SoundCloud `client_id` resolver and YouTube `yt-dlp -J ytsearch5:`
  pattern from `discover.rs`.
- Each result row: thumbnail, title, channel/artist, duration, source badge,
  "Download" button + format/destination toggles already in the URL bar.
- Cap results to 5–10 per source, dedupe by title-similarity.
- Optional: cache recent searches so common queries are instant on repeat.

### Rooms (plug.dj-style live listening)
The skeleton in `api/` and `app/src/components/rooms/` exists but is unfinished.
Pick up where it left off:
- Server-side transcode (ffmpeg via the `transcode.ts` already started) → WebM
  Opus for relay; never serve raw user uploads.
- DJ queue: who's up next, rotation logic, vote-to-skip threshold.
- Real-time chat (already wired via WS).
- Sync clock between server + clients so all listeners hear the same audible
  position to within ~50ms (currentTime broadcast every second, clients seek
  if drift > N).
- Auth: a tiny username/PIN system to start, no real user accounts yet.
- "DJ from library": instead of uploading, DJ picks a track from their local
  library and the app uploads it to the room transparently.

## Known issues / cleanup

### Native audio engine (architectural refactor)
Replace the HTML `<audio>` element with a Rust playback pipeline. This is the
correct foundation for a desktop music app and unlocks several features that
are awkward or impossible with the browser audio element.

- **Why**: cross-origin restrictions on `MediaElementSource` make in-browser
  FFT visualizers fragile; HTML audio has no real gapless playback, no EQ, no
  ReplayGain, no output device selection, choppy seek precision, and no easy
  system media-key integration.
- **Approach**: `symphonia` for decode (handles MP3/FLAC/OGG/M4A/WAV/AAC) +
  `cpal` (or `rodio`) for output. Between decode and output, run an FFT
  (`realfft` crate, ~50 µs/frame) and emit ~32–48 frequency bands via Tauri
  events at ~30 Hz. Frontend becomes a thin command/event shim.
- **Workaround in place**: custom `wjaudio://` Tauri URI scheme serves files
  with permissive CORS so `MediaElementSource` works for the spectrogram.
- **Cost**: ~500–1000 lines of Rust, ~1–2 days focused work.

### Stale rows after external file changes
- Manual `pencil` edits already detect "file not found" and surface a hint to
  rescan. Generalize: a periodic background "verify" pass that flags missing
  files and offers a one-click cleanup.
- The library cache only deletes missing files when its parent folder is
  rescanned. If a folder is renamed at the OS level the entire cache for it
  goes stale; need a "reattach folder" UI.

### Cover-art approval modal
Currently shows one candidate at a time. Improve: show all gathered candidates
side-by-side so the user can pick the best, not just accept/reject sequentially.

### `discover_keep` doesn't honor destination
Discover keeps go to `outputDir` only — should respect the new
`Downloads / Music` destination toggle the same way `start_download` does.

## Possible expansions (ideas, not committed)

- **System media keys + SMTC integration**: play/pause/skip from the keyboard
  media keys and Windows' floating media controls. Easier post Rust-engine
  refactor.
- **Mini-mode window**: collapse to a small always-on-top window showing just
  album art + controls.
- **Crossfade / gapless**: requires the Rust audio engine.
- **Per-track ReplayGain / loudness normalization**: scan once during library
  add (`ffmpeg -af volumedetect`), store dBFS on the row, apply gain at
  playback. Stops the volume jumping between tracks.
- **Lyrics**: pull from LRClib (free, open) and display synced lyrics in
  immersive mode. Cache to DB.
- **Recommendations from your library**: existing Discover uses Last.fm/SC/YT
  seeded by user input. Could automatically seed from your most-played tracks
  and surface "you might also like" without manual seeds.
- **Stream Deck endpoints already exist** — extend with: skip-back, skip-fwd,
  toggle-shuffle, toggle-immersive-mode, set-volume-absolute, like-current.
- **"Like" / favorite**: a simple boolean flag per track. Quick filter button
  in library; could also auto-seed Discover.
- **Genre/mood tags**: derive from MusicBrainz on auto-tag, store as a
  comma-separated column or join table; filter library by tag.
- **BPM + key detection**: per-track tempo and musical key, computed once on
  library scan and stored as columns on `library_tracks`.
  - **BPM**: `aubio` via FFI is the canonical option (rock-solid). Pure-Rust
    alternatives are thinner — could roll our own onset-detection over the
    PCM ffmpeg already gives us for the waveform. Display in library, sort by
    tempo, use as a smart-playlist filter ("upbeat workout = 130–150 BPM").
  - **Key**: harder. The Krumhansl-Schmuckler profile method is doable in
    Rust over chroma features, but accuracy is mediocre on EDM/hip-hop. Best
    open-source result is Essentia (C++), which is heavy to bind. Pragmatic:
    ship BPM first; key as a stretch goal.
  - DJ-room utility: matches a track to the previously played one within a
    BPM window and compatible Camelot key for smoother transitions.
  - Display: sortable columns + a "Mix" view that suggests the next track
    based on tempo/key compatibility with the currently playing one.
- **Audio fingerprinting (Chromaprint)**: identify untagged tracks against
  AcoustID. Solves the "I have this MP3 with no tags" problem better than
  filename parsing.
- **Track waveform color extraction**: re-color the player-bar waveform
  per-track using the same dominant-color extraction as immersive mode.
- **Auto-download cover art on library add**: combine the scan and the
  existing cover-art finder so Add Folder also fills missing art in one pass.
- **Drag and drop into the app**: drop an audio file or a YouTube URL on the
  window to import / download.
- **Export / import settings + library state**: a single JSON/zip bundle for
  backup and cross-machine sync.
- **Audio device picker** (post Rust-engine refactor): route output to
  speakers vs headphones from a player-bar dropdown.
- **Spotify / Apple Music import**: paste a playlist URL, app fetches the
  track list and queues searches against YouTube/SoundCloud. Bulk fill a
  library folder from a Spotify playlist.

# Wavejack multi-device sync notes

Context: Windows = ingest machine, macOS = DJ machine running Rekordbox + a
separate Python toolchain for Rekordbox library processing. Music files travel
via Syncthing. Rekordbox library does NOT move. Wavejack's job is "URL →
cleanly-tagged file in a folder Rekordbox watches."

## Two viable models

**A. Wavejack on Windows only** (Mac runs only Rekordbox + Python tools)
- Wavejack writes to a Syncthing-managed folder; Mac just sees files appear.
- Zero coordination problems. Mac never needs the app installed.
- Downside: if you're on the Mac and want to pull a track, you're stuck.

**B. Wavejack on both, ingest from either side**
- Both machines write into the same synced folder.
- Needs rules so Syncthing doesn't churn or conflict (see below).
- DB and settings stay strictly per-machine.

Lean **B** for flexibility — sync rules aren't hard, and sometimes you'll want
to grab something at the DJ machine.

## What needs to change for B to feel good

**1. Working dir ≠ synced library dir.** Today yt-dlp/tidal-dl-ng write into
the destination directly, which means `.part` / `.ytdl` files appear there
mid-download. Syncthing will pick those up and churn. Two ways to fix:
- Download to a local temp dir, atomic-move into the library folder on
  completion (cleanest)
- Or just ship a `.stignore` template that excludes temp patterns

The first is better because Syncthing also won't replicate a track that's
still being tagged/renamed by post-processing.

**2. Atomic tag writes.** When you embed cover art or rewrite ID3 a few
seconds after download lands, Syncthing might capture the file mid-write.
The `id3` crate writes via temp file already; verify `lofty` and the
cover-embed paths do the same. If not, write-to-temp-then-rename.

**3. DB stays per-machine.** Don't even try to sync `wavejack.db`. SQLite +
Syncthing = pain, and the data in there (play_count, waveforms, Last.fm tags,
Wavejack playlists) is exactly the stuff that's not needed anyway.

**4. Settings stay per-machine.** `settings.json` has absolute paths
(`musicDir`, `outputDir`) that differ Windows vs Mac. Don't sync.

**5. Ship a `.stignore` template** for the synced folder:
```
*.part
*.ytdl
*.tmp
.DS_Store
._*
.Trashes
wavejack.db*
.wavejack-preview/
```

## What can probably be gutted from Wavejack

If Rekordbox owns organization, these features just add overhead:
- **Wavejack playlists** (`playlistStore`, `PlaylistPanel`, `playlist_tracks`
  table) — Rekordbox owns this
- **Library tab** as a browser — browse in Rekordbox; Wavejack just needs
  "where does the file go"
- **play_count / last_played tracking** — Rekordbox does this
- **Last.fm tag fetching** — Python tools or Rekordbox tags can replace this

Don't necessarily *delete* them, but consider hiding them behind a settings
flag so the app is mostly Home/Downloads/Discover/Feed and the library tab is
gone.

What to keep:
- URL/search ingest (the actual point)
- Spotify/Tidal matching + download
- MetadataPicker (MusicBrainz cleanup before file enters library)
- Discover/Feed (ingest-adjacent)
- Cover art finder

## Concrete next steps

1. **Local staging for downloads** — yt-dlp + tidal-dl-ng write to
   `app_data/staging/`, atomic-move to `musicDir` only after tags/cover are
   finalized. This is the single highest-leverage change for sync hygiene.
2. **Ship `.stignore`** in the repo, documented in README
3. **Hide Library + Playlists tabs** behind a "lite mode" setting (don't
   delete — might still want them locally on Windows for spot-checking)
4. macOS portability fixes (yt-dlp URL per-OS, tidal-dl-ng hint, window
   chrome) — see other notes
5. macOS junk-file filter in library scan so `.DS_Store` / `._*` don't
   pollute when scanning from the Mac side

The staging dir change is worth doing regardless of A vs B — even on Windows
alone, having tag-writes complete before the file is "live" in the library
is just cleaner.

---

# Dedupe + library hygiene (deferred — capture only)

Goal: don't re-download tracks already in the library. Optionally upgrade if
the new download is strictly higher quality (FLAC > AAC > MP3 by bitrate).

## Constraint that shapes the design

The existing 4500-track Rekordbox library mostly does NOT have ISRC tags. So
ISRC-only dedupe gives false negatives for any new download whose match
already lives in the legacy library. The chromaprint cache (lives in
`rekordbox-mem`, see below) is the only signal that bridges to the legacy
library.

## Three independent layers (each opt-in or always-on)

**1. ISRC dedupe — built-in, always on, ~free**
- Add `isrc` column to `download_history` (and library_tracks).
- Populate from Spotify/Tidal metadata at ingest.
- Pre-download: lookup. If found, skip or upgrade based on quality compare.
- Useful for Spotify/Tidal-on-Spotify/Tidal collisions.
- USELESS against the 4500 untagged legacy tracks.

**2. Staging dir + atomic move — built-in, always on**
- yt-dlp / tidal-dl-ng write to `app_data/staging/`.
- After tags + cover finalize, atomic-move into `musicDir`.
- Benefit on its own: tag/cover writes complete before file is "live"
  (cleaner regardless of sync).
- Benefit for Syncthing: replicated file is always a complete, fully-tagged
  artifact — no `.part` churn, no half-tagged replication.

**3. Chromaprint dedupe — opt-in via settings, off by default**
- Settings: toggle + path to `fingerprints.msgpack` + matcher command.
- Off → ingest runs exactly as today (other users / minimal config).
- On → post-stage, shell to matcher, decide skip/upgrade/keep.
- Required because of the ISRC-less legacy library.

## Chromaprint cache details (from `rekordbox-mem`)

- Path: `rekordbox-mem/cache/fingerprints.msgpack`
- Format: msgpack, single file, atomic write (`tmp.replace()`) — Syncthing-safe
- Schema: `{track_id: {fp: [uint32], duration: float, file_size: int, file_path: str}}`
- Stores the *decoded* fingerprint (uint32 array), not base64
- ~5 KB/track → ~20 MB for 4500 tracks
- Keyed by Rekordbox track ID — so lookup for a NEW download is NOT a hash
  hit; you have to do chromaprint *matching* (Hamming distance over int
  arrays, comparing entries with similar duration). `matcher.py` already
  does this.

## Two-writer problem

If both Mac (Python tool) and Windows (Wavejack) write `fingerprints.msgpack`,
Syncthing conflicts. Solve by single-writer-per-file:
- Mac Python tool owns `fingerprints.msgpack` (no change).
- Wavejack on each machine writes its own append-only sidecar
  (`wavejack-fingerprints-<hostname>.msgpack` or NDJSON) for tracks it
  ingested.
- Lookup checks main cache + any sidecars present.
- Periodic merge: next Python precompute run absorbs sidecar entries.

## Implementation paths for the matcher invocation

**A. Shell to a Python helper in `rekordbox-mem`** — easiest.
   - Add `python -m extractor.tools.match_file <staged> [--cache PATH]`
     → `{"match": {"id", "path", "confidence", "duration_delta"} | null}`
   - ~30-line script wrapping existing `FingerprintStore` + `matcher.py`
   - Wavejack invokes, parses JSON
   - Requires Python on the Wavejack machine (Mac fine, Windows annoying)

**B. Port matching to Rust** — `rmp-serde` reads msgpack, hand-port the
   sliding Hamming distance from `matcher.py` (or use `rusty-chromaprint`).
   No runtime Python. More upfront work.

Default to A. Port to B only if Python-on-Windows turns out to be a pain.

## Optional shared package (`music-library-tools`)

Tempting to extract `FingerprintStore` + `matcher.py` + dedupe-quality-rank
into a shared `mlt` package at `C:/projects/music-library-tools` so both
`rekordbox-mem` and Wavejack can use it.

DECISION: skip for now. One Python project + one Rust project = no real
shared interface to design yet. Just add the `match_file.py` script to
`rekordbox-mem` directly. Extract later if a third consumer shows up.

## Estimated effort if we do it

- ISRC column + lookup: ~1h
- Staging dir refactor: ~2-3h (touches yt-dlp + tidal-dl-ng paths)
- Chromaprint command + settings UI + `match_file.py` script: ~2-3h
- Total: ~half a day

## Suggested order if we ever do it

1. Staging dir + atomic move (best-bang independent of dedupe)
2. ISRC column + lookup (free win, no external deps)
3. `match_file.py` in rekordbox-mem
4. Chromaprint integration in Wavejack (opt-in)
5. Sidecar merge in rekordbox-mem (long-term hygiene)

## Status

Captured but NOT implemented. Reconsider when Wavejack actually starts
running on macOS, or when re-downloading a track you already have actually
becomes annoying.


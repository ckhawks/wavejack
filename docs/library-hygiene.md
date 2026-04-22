# Library Hygiene

Features for keeping the local music library clean, deduplicated, and high-quality.

## 1. Expanded "Needs Fix" Detection

Extend the existing needs-fix flagging to catch common YouTube-rip artifacts in track titles.

**Flag titles matching (case-insensitive):**
- `Visualizer`
- `Official Audio`
- `Official Video`
- `Official Music Video`
- `Lyric Video` / `Lyrics Video`
- `[HD]` / `[4K]` / `(HD)` / `(4K)`
- `Audio Only`
- `Full Album` (usually means it's a compilation, not a track)

**Notes:**
- Soft flag (suggestion), not auto-action — false positives exist (e.g. a track legitimately named "Visualizer").
- Show alongside existing needs-fix indicators in the library UI.
- Consider a "suggested clean title" that strips the matched suffix.

## 2. Duplicate Detection via Chromaprint

Detect duplicate tracks by audio fingerprint, not just filename/metadata.

**Approach (leveraging puck-festival learnings):**
- Shell out to `fpcalc` (chromaprint CLI) from Rust — bundle the binary with the Tauri app.
- Store raw fingerprint + duration in SQLite (new table, keyed by wavejack track ID).
- Matcher: Hamming distance on sliding windows, ported from puck-festival's `matcher.py`.
- Gates (from puck-festival, proven in production):
  - `ABSOLUTE_GATE = 0.38` — reject matches above this score
  - `MARGIN_GATE = 0.020` — 2nd-best must exceed best by this margin
  - `DUPE_TIE_EPSILON = 0.005` — detects byte-identical duplicates

**Why not reuse puck-festival's cache directly:**
- Cache is msgpack on the Mac, keyed by Rekordbox track ID (doesn't map to wavejack IDs).
- Approach is reusable; data is not.

**Why Rust + `fpcalc` over Python:**
- Avoids Python-in-Tauri packaging pain.
- `rusty-chromaprint` + `symphonia` is an option if we want pure-Rust later.
- Matcher math is ~50 lines of numpy-style ops, trivial in Rust.

**UI:** cluster view of suspected duplicates, user picks which to keep.

## 3. Low-Bitrate Re-Download

Surface tracks below a quality threshold and offer to re-download better versions.

**Detection:**
- Scan existing metadata (already have file info); flag anything `< 192 kbps`.
- Show bitrate column in library view for quick triage.

**Re-download flow:**
- Opt-in per track, not batch — avoid churning through downloads for marginal gains.
- Re-search the source preferring higher-bitrate streams.
- Keep old file until new one is verified (atomic swap + DB update).

**Risks:**
- Some sources genuinely don't have higher quality available — need to detect "no improvement found" and not re-download the same file.
- Bitrate is a weak proxy for quality (a 320kbps transcode from 128kbps is still bad). Future: pair with fingerprint comparison to detect when re-download is actually different audio.

## 4. Orphaned File Detection + Relocation

Reconcile the DB against what's actually on disk, and let the user fix mismatches without re-importing.

**Two kinds of orphans:**
1. **DB → disk missing:** DB has a track, file at recorded path doesn't exist (user moved/renamed it outside the app).
2. **Disk → DB missing:** audio file in the library root that no DB row points to (user dropped it in manually).

**Detection:**
- Background scan walks the library root, builds a set of paths on disk.
- Compare against DB paths — anything in one set but not the other is an orphan.
- Cheap: run on startup + on manual trigger. Skip unchanged dirs via mtime.

**Relocation for DB → disk missing:**
- For each missing track, compute a match score against on-disk orphans using:
  1. **Filename similarity** (fuzzy match on basename).
  2. **File size** match (exact byte size is a strong signal).
  3. **Duration** match (requires quick ffprobe, or cache from last scan).
  4. **Chromaprint** (if already fingerprinted — definitive match).
- UI: show missing track, list ranked candidates, user confirms or browses manually.
- One-click "relocate" updates the DB path; no re-import, preserves play history/playlists/tags.

**Adoption for disk → DB missing:**
- Offer to import the orphan (same flow as normal import).
- If its fingerprint matches an existing DB track with a missing file, suggest relocation instead of adoption (avoids duplicates).

**Bulk mode:**
- "Auto-relocate high-confidence matches" — anything with exact size + fingerprint match can be relocated without user confirmation.
- Everything else queued for manual review.

## 5. Filename Sanitization

Strip invisible characters and normalize filenames for cross-filesystem (macOS + Windows) compatibility.

**Strip / replace:**
- **Invisible junk:** U+200B (ZWSP), U+200C/D (ZWNJ/ZWJ), U+FEFF (BOM), U+00A0 (NBSP → regular space), LTR/RTL marks
- **macOS reserved:** `:` (Finder renders as `/`, breaks Terminal), leading `.` (hides file), trailing `.` or space
- **Windows reserved:** `< > : " / \ | ? *`, reserved names `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`
- **Control chars:** anything `< 0x20`

**Normalization:**
- Force **NFC** Unicode normalization. APFS accepts either but mixing NFC/NFD causes duplicate-looking files when syncing (a file named `café` in NFC won't match NFD `café`).

**Length:**
- Cap at 255 **bytes** (not chars) — UTF-8 chars can be 1-4 bytes, and some filesystems limit by bytes.

**Rollout:**
- **Going forward:** sanitize at download time (yt-dlp post-processing or Rust-side before write).
- **One-shot migration:** pass over existing library.
  - Dry-run first: show the full rename diff.
  - Atomic: rename on disk + update DB path in the same transaction.
  - Reversible: keep a log of `(old_path, new_path)` pairs for rollback.
- The migration is the risky part — old paths may be referenced by playlists, history, etc. Audit all DB tables that store paths before running.

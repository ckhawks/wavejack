# Multi-Device Sync & Rekordbox Integration

Design notes for running Wavejack on both a home desktop (listening / crate-digging)
and a Mac laptop (Rekordbox DJ sessions), while preserving local-first principles.

## Goals & Constraints

- **Local-first.** No cloud dependency; music and metadata live on the user's devices.
- **Offline-capable on Mac.** Full library must be available without internet for gigs.
- **Wavejack is the library manager.** Primary tool for organizing music outside of DJ sessions.
- **Rekordbox metadata must survive.** Cues, beatgrids, hot cues, gig play counts never get lost.

## Division of Concerns

**Wavejack owns:**
- Files on disk, folder structure
- Library tags, playlists, smart crates
- Listening play counts, crate-digging notes
- Everything done *between* gigs

**Rekordbox owns:**
- Cues, beatgrids, hot cues, memory cues
- Gig play counts
- DJ-specific playlists built during prep
- The performance layer

## Data Flow

### Wavejack ↔ Wavejack (desktop ↔ Mac)

- **Audio files:** Syncthing (peer-to-peer, LAN-direct, no cloud). Leaves real files on both disks.
- **Wavejack DB:** never sync the SQLite file directly — corruption and silent conflict loss.
  Instead, use an **append-only op log** per device inside the Syncthing folder
  (`desktop-ops.jsonl`, `laptop-ops.jsonl`). Each op is timestamped and idempotent.
  On launch, each Wavejack instance replays the *other* device's log into its local DB.
  Works offline on both sides; Syncthing handles transport.

### Wavejack → Rekordbox

- **One-way push** via Rekordbox XML import.
- New files, playlists, and tag-based smart crates flow in as XML.
- Rekordbox picks up new files on next launch. Sanctioned path; won't corrupt `master.db`.

### Rekordbox → Wavejack

- **One-way read** from `master.db` (SQLCipher-encrypted SQLite at
  `~/Library/Pioneer/rekordbox/master.db`). The encryption key is known and stable;
  [`pyrekordbox`](https://github.com/dylanljones/pyrekordbox) is the reference implementation.
- Surface cue counts, last-gigged-at, gig play counts, etc. as **decoration** in Wavejack UI.
- **Not stored as truth** in Wavejack's DB — just displayed. Rekordbox remains source of truth
  for DJ metadata.

## Why No Two-Way Write to `master.db`

Technically possible; practically risky:

- Rekordbox must be **fully closed** — it holds the DB open and will overwrite changes.
- Schema changes between Rekordbox versions; Pioneer updates can break writes.
- Rekordbox Cloud sync (if enabled) can silently overwrite local changes.
- Pioneer could rotate the encryption key in any future update.
- No official support; corruption = on your own.

## The Hard Part: File Moves

If Wavejack reorganizes folders on desktop and syncs to Mac, Rekordbox sees "missing" tracks
because it caches old paths.

Options, in order of preference:

1. **Convention:** lock folder structure once a track is in Rekordbox. Simplest; start here.
2. **Narrow `master.db` write:** Wavejack-on-Mac detects the move and writes *only* the path
   field, with Rekordbox closed. Well-scoped, much safer than full two-way sync.
3. **Manual relocate:** accept that Rekordbox's "relocate missing files" flow gets used
   occasionally.

## Suggested Phasing

1. **Phase 1 — files only.** Set up Syncthing for the audio folder. Wavejack stays desktop-only.
   Build Rekordbox XML export in Wavejack (desktop → Mac Rekordbox).
2. **Phase 2 — Wavejack on Mac, read-only Rekordbox integration.** Port Wavejack to Mac
   (Tauri cross-compiles). Add `master.db` reader to surface DJ metadata in the UI.
3. **Phase 3 — Wavejack DB sync.** Implement the op-log system for Wavejack ↔ Wavejack sync
   across the two machines.
4. **Phase 4 (maybe).** Narrow `master.db` writes for file-move relocates, behind a feature
   flag with mandatory backup.

## Alternatives Considered

- **Cloud storage (Dropbox/iCloud):** rejected — violates local-first; doesn't sync Rekordbox DB anyway.
- **NAS / SMB share:** viable but adds hardware and requires VPN/Tailscale away from home.
- **Sync via `api/` server:** more robust than op-log-via-Syncthing, but makes the server
  a dependency for full function, which erodes the local-first feel. Revisit if op-log proves
  insufficient.
- **Full two-way merge into `master.db`:** rejected — maintenance tax from Pioneer schema
  churn and corruption risk outweigh benefits.

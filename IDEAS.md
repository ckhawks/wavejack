# Siphon — Feature Ideas

## Queue & Workflow
- **Scheduled downloads** — queue URLs to download at a specific time or when bandwidth is available (e.g., overnight)
- **Clipboard monitoring** — watch the clipboard for supported URLs and auto-add them (with a toast to confirm/dismiss)
- **Drag-and-drop URL import** — drop a list of URLs (or a .txt file) onto the window to batch-queue them
- **Retry with different backend** — let users manually pick Cobalt vs yt-dlp per download instead of auto-fallback only
- **Download speed limiter** — configurable bandwidth cap so downloads don't saturate the connection

## Library & Organization
- **Library view / tab** — browse all past downloads as a searchable, filterable grid (by artist, album, date, format) rather than just a queue
- **Auto-organize folders** — option to save files into `Artist/Album/` subdirectories automatically
- **Tagging rules** — user-defined rules like "anything from this channel → genre: Podcast"
- **Duplicate detection** — warn before downloading a URL that's already in history

## Audio Player
- **Queue/playlist playback** — build a play queue from multiple downloads, not just prev/next through all MP3s
- **Shuffle & repeat modes**
- **Equalizer** — basic EQ presets (bass boost, vocal, flat)
- **Keyboard shortcuts** — space to pause, arrow keys to seek, media key support

## Metadata & Enrichment
- **Batch auto-tag** — select multiple MP3s and auto-tag them all in one pass
- **Lyrics fetch** — pull lyrics from an API and embed as ID3 USLT frames (or display in the player)
- **Genre tagging** — MusicBrainz has genre data; pull it in alongside artist/album
- **Waveform visualization** — show a waveform in the player instead of (or alongside) the seek bar

## Video
- **Quality picker** — let users choose resolution/bitrate before downloading (yt-dlp exposes format lists)
- **Video player** — extend the audio player to handle MP4 playback in-app
- **Thumbnail preview** — show video thumbnails in the queue before download completes
- **Subtitle download** — fetch and embed subtitles (yt-dlp `--write-subs`)

## Import/Export & Integration
- **Export to playlist formats** — generate .m3u/.pls files from download history
- **Browser extension companion** — a simple extension that sends the current page URL to Siphon via localhost API
- **Spotify/YouTube Music import** — paste a playlist link from a streaming service and resolve each track
- **Discord Rich Presence** — show what's currently playing

## Polish & UX
- **System tray mode** — minimize to tray, show download progress as a badge
- **Notifications** — OS-level notification when a download completes or a batch finishes
- **Themes** — light mode, accent color picker, or a few built-in themes
- **Statistics dashboard** — total downloads, storage used, most-downloaded domains, downloads over time

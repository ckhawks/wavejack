# Wavejack

A desktop app for downloading, organizing, and sharing music.

## Features

### Downloader
- Download audio/video from YouTube, SoundCloud, and 1000+ sites via yt-dlp
- Fallback to self-hosted Cobalt instance
- MP3/MP4 format selection
- Playlist detection and batch downloading
- Auto-tag with MusicBrainz metadata and cover art
- Built-in audio player with album art, seek, and volume

### Rooms (coming soon)
- Create or join DJ rooms
- Take turns playing music from your local library
- Upvote, downvote, or save tracks to your own collection
- Real-time chat and synchronized playback

## Tech Stack

| Component | Stack |
|-----------|-------|
| Desktop app | Tauri v2 (Rust) + React + TypeScript |
| Styling | Tailwind CSS v4 |
| State | Zustand |
| Database | SQLite (local download history) |
| Room server | TypeScript + WebSockets |
| Audio processing | ffmpeg (server-side transcoding) |

## Project Structure

```
wavejack/
├── app/           # Tauri desktop app
│   ├── src/       # React frontend
│   └── src-tauri/ # Rust backend
├── api/           # Room/streaming server
│   └── src/
└── CLAUDE.md      # Development guidelines
```

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) + [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)
- [ffmpeg](https://ffmpeg.org/) (for audio processing)

### Desktop App
```bash
cd app
pnpm install
pnpm tauri dev
```

### API Server
```bash
cd api
pnpm install
pnpm dev
```

## License

TBD

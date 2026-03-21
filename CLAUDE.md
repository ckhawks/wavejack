# Wavejack

A desktop media app with two core features:
1. **Downloader** — download and organize music/video from the web (yt-dlp + Cobalt backends)
2. **Rooms** — plug.dj-style DJ rooms where users take turns playing local music to a shared room

## Architecture

```
wavejack/
├── app/          # Tauri v2 desktop app (Rust backend + React frontend)
│   ├── src/      # React UI (TypeScript)
│   └── src-tauri/# Rust backend (Tauri commands, SQLite, yt-dlp, metadata)
├── api/          # Room server (TypeScript, WebSockets)
│   └── src/
└── CLAUDE.md
```

## Rules & Guidelines

### General
- Use pnpm as the package manager (run from workspace root or specific package dir)
- Run the Tauri app from `app/`: `cd app && pnpm tauri dev`
- Run the API from `api/`: `cd api && pnpm dev`
- Keep packages independent — the app and API should not import from each other directly
- Shared types between app and API should be duplicated (not shared via a package) until there are enough to justify a shared package

### TypeScript (Frontend + API)
- Strict mode is on — no `any` types unless absolutely unavoidable
- Use functional React components with hooks, never class components
- State management: Zustand stores (not React context for global state)
- Styling: Tailwind CSS v4 (no CSS modules, no styled-components)
- Prefer named exports over default exports
- Use `interface` for object shapes, `type` for unions/intersections
- Keep components small — if a component file exceeds ~200 lines, split it
- Colocate hooks, types, and utils near where they're used (not in a global `utils/` folder)

### Rust (Tauri Backend)
- All Tauri commands must return `Result<T, AppError>` — never panic in command handlers
- Use `thiserror` for error types, not string errors
- Keep `lib.rs` as a thin orchestration layer — business logic lives in dedicated modules
- Async by default — use `tokio::spawn` for background work, emit events for progress
- Database operations go through `database.rs` — no raw SQL scattered in other modules
- External API calls go through dedicated modules (e.g., `cobalt.rs`, `metadata.rs`)

### API Server (Rooms)
- Use Hono or Fastify (TBD) with WebSocket support
- All real-time communication over WebSockets — REST only for non-realtime operations (auth, room listing)
- Audio files uploaded by DJs must be transcoded server-side via ffmpeg before relaying to listeners
- Never serve raw uploaded files to clients — always sanitize through ffmpeg
- Rate limit API endpoints appropriately
- Validate all incoming WebSocket messages against a schema

### Security
- Never trust client-side data — validate on the server
- Audio file validation: check magic bytes, enforce size limits, transcode through ffmpeg
- No secrets in code — use environment variables
- Sanitize user-generated content (room names, usernames, chat messages)
- The Tauri app's CSP should be tightened before any public release

### Git & Workflow
- Commit messages: imperative mood, concise, describe the "why" not just the "what"
- One logical change per commit — don't mix unrelated changes
- Branch naming: `feature/description`, `fix/description`
- Don't commit `node_modules/`, `dist/`, `target/`, or `.env` files
- Don't commit large binary files (audio, video) — use .gitignore

### Code Quality
- No dead code — if it's not used, delete it
- No commented-out code in commits — use git history instead
- Prefer early returns over deeply nested conditionals
- Error messages should be actionable — tell the user what went wrong and what to do
- Log errors on the backend, show user-friendly messages on the frontend

### Performance
- Don't block the main thread in Tauri — heavy work goes in `tokio::spawn`
- Lazy-load heavy frontend components (e.g., settings modal, metadata picker)
- Debounce search inputs and other rapid-fire user actions
- Use WebSocket connection pooling on the API — don't create new connections per message

### Testing (when we get there)
- Rust: unit tests in-module (`#[cfg(test)]`), integration tests in `tests/`
- TypeScript: Vitest for unit tests, Playwright for E2E
- Test behavior, not implementation — mock external services, not internal modules

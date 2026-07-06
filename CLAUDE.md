# Wavejack

Desktop media app: (1) download/organize music+video via yt-dlp/Cobalt, (2) plug.dj-style DJ rooms with local music.

## Ecosystem

One of four sibling repos (all under `github.com/ckhawks`). Wavejack = acquisition + casual local library + Rooms — **not** the canonical DJ library (that's Rekordbox, managed by `music-library-tools` + `puck-festival-tools` on the Mac). Wavejack's SQLite library is casual/personal and hands tagged files to the Mac side via a synced inbox. Full cross-repo picture + settled decisions: https://github.com/ckhawks/puck-festival-tools/blob/main/ecosystem-map.md

## Structure

- `app/` — Tauri v2 (Rust + React/TS), `cd app && pnpm tauri dev`
- `api/` — Room server (TS + WebSockets), `cd api && pnpm dev`
- pnpm workspaces; packages stay independent; duplicate shared types until a shared pkg is justified

## TypeScript

- Strict, no `any`; named exports; `interface` for objects, `type` for unions
- React: functional + hooks only; Zustand for state; Tailwind v4 for styles
- Components <200 lines; colocate hooks/types/utils near usage

## Rust

- Commands return `Result<T, AppError>`; `thiserror` for errors; never panic
- `lib.rs` = thin orchestration; logic in modules (`database.rs`, `cobalt.rs`, etc.)
- Async default; `tokio::spawn` for background work; emit events for progress

## API (Rooms)

- Hono or Fastify (TBD) + WebSockets
- WS for realtime; REST only for auth/room listing
- DJ uploads → server transcodes via ffmpeg → relay to listeners; never serve raw uploads
- Validate all WS messages against schema; rate limit endpoints

## Security

- Validate server-side: magic bytes, size limits, ffmpeg transcode
- No secrets in code (env vars); sanitize UGC; tighten CSP before release

## Quality

- No dead/commented-out code; early returns; actionable error messages
- Log errors backend, user-friendly messages frontend
- Don't block Tauri main thread; lazy-load heavy components; debounce inputs

## Git

- Imperative commit messages; one logical change per commit
- Branches: `feature/x`, `fix/x`; no binaries/node_modules/dist/target/.env

## Testing

- Rust: `#[cfg(test)]` + `tests/`; TS: Vitest + Playwright
- Test behavior not implementation; mock external services only

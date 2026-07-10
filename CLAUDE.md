# Wavejack

Desktop media app: (1) download/organize music+video via yt-dlp/Cobalt, (2) plug.dj-style DJ rooms with local music.

## Structure

- `app/` — Tauri v2 (Rust + React/TS), `cd app && pnpm tauri dev`
- `api/` — Room server (TS + WebSockets), `cd api && pnpm dev`
- pnpm workspaces; packages stay independent; duplicate shared types until a shared pkg is justified
- **One lockfile, at the repo root.** Install from root with `pnpm --filter @wavejack/app add -D <pkg>` — never `cd app && pnpm add` (a stray nested `app/pnpm-lock.yaml` makes pnpm resolve a conflicting dep tree and breaks the dev server). If an install desyncs `node_modules`, `pnpm install` at root reconciles it; clear `app/node_modules/.vite` and restart the dev server.

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

- Rust: `#[cfg(test)]` + `tests/` — run `cargo test` in `app/src-tauri`
- TS: Vitest — `pnpm test` in `app/` and `api/` (`test:watch` for watch mode). Playwright not set up yet
- Frontend store tests run in a node env (`app/vitest.config.ts`, no React/Tailwind plugins); mock the Tauri IPC boundary (`../lib/commands`) and cross-store deps at the module level so importing a store never hits `invoke`
- Prefer pure, exported helpers as test seams (e.g. `resolveAdjacent`, `non_clobbering_path`, `normalize_tag`)
- Test behavior not implementation; mock external services only

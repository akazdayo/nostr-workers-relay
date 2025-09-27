# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` hosts the Durable Object-backed Nostr relay; `Listener` stores kind-1 events and serves `/get-event`.
- `src/text_analyzer.py` and `fonts/` support offline wordcloud generation (output defaults to `wordcloud.png`).
- `dist/` is reserved for Wrangler build artifacts; avoid editing by hand. Configuration lives in `wrangler.jsonc` and generated bindings are tracked in `worker-configuration.d.ts`.

## Build, Test, and Development Commands
- `npm install` (or `pnpm install`) sets up TypeScript and Wrangler dependencies.
- `npm run dev` starts `wrangler dev`, exposing the Worker locally with Durable Objects.
- `npm run deploy` publishes to Cloudflare with minification; confirm migrations in `wrangler.jsonc` before running.
- `npm run cf-typegen` regenerates Cloudflare binding types; re-run after updating `wrangler.jsonc`.
- `uv run python src/text_analyzer.py` fetches recent event content and regenerates the word cloud; requires Python 3.8+ and the packages listed in `pyproject.toml`.

## Coding Style & Naming Conventions
- Favor TypeScript modules with ES imports/exports; keep 2-space indentation and terminate statements with semicolons to match existing files.
- Namespace Durable Object bindings as uppercase (e.g., `LISTENTER`) and reuse defined `Env` types when accessing them.
- For Python utilities, follow snake_case functions and keep Japanese comments concise and actionable.

## Testing Guidelines
- Unit tests are not yet established; verify Worker changes with `npm run dev` and a WebSocket client (`wscat --connect ws://localhost:8787` or similar) by sending `EVENT` messages.
- Check `/get-event` via `curl http://localhost:8787/get-event` to confirm storage behavior.
- When adding automated tests, prefer lightweight TypeScript harnesses under `src/__tests__/` and ensure Durable Object state is stubbed or isolated.

## Commit & Pull Request Guidelines
- Commit history favors short, task-focused messages (often Japanese); keep summaries imperative and scoped to a single change.
- Include context in the body when touching Durable Object schema or migrations. Reference related issues or screenshots when behavior changes.
- For PRs, describe testing performed (`wrangler dev`, manual WebSocket validation, wordcloud regeneration) and call out required config updates or secrets.

## Security & Configuration Tips
- Do not commit real Cloudflare credentials; rely on `wrangler secret` for sensitive values.
- Update `migrations` when changing Durable Object storage shape, and coordinate deployments to avoid data loss.
- Fonts shipped in `fonts/` are licensed for embedding; keep any replacements under compatible licensing.

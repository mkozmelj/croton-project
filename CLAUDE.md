# Croton Project — Training Agent

Personal AI training coach for a single amateur multi-sport athlete. Telegram bot + Claude API + Strava/Google Calendar/Intervals.icu integrations, on a hard €20/month budget.

**Read before touching code:** `docs/guide/05-architecture.md` (code map, flows, data model) → `docs/02-architecture-decisions.md` (binding decisions and their reasons) → `ROADMAP.md` (what's open). `docs/01-stack-and-principles.md` has the per-technology conventions below in full detail. User-facing setup docs are in `README.md` and `docs/guide/`.

## Non-negotiable rules

- **Single Claude-call wrapper.** Every Claude API call goes through `src/agent/claude.ts`. No other file calls `client.messages.create`/`stream` directly. It owns budget-checking, usage logging, and the cached-system-prompt structure.
- **Model IDs are constants, never inline strings.** `MODELS.sonnet` = `claude-sonnet-5`, `MODELS.haiku` = `claude-haiku-4-5`, defined once in `src/config/env.ts`. See `docs/02-architecture-decisions.md` ADR-001.
- **System prompt caching is structural, not optional.** Static training-principles content first (with `cache_control`, 1h TTL), dynamic athlete/session context appended after. Never interpolate anything dynamic before the cache breakpoint. ADR-004.
- **`conversations.content` is `jsonb`, storing full Anthropic content-block arrays** — not summarized text. Needed to replay `tool_use`/`tool_result` correctly. ADR-003.
- **Every webhook write is an upsert** (`onConflictDoUpdate`), never a plain insert — Strava retries webhooks and the Intervals.icu sync re-reads recent days. ADR-009.
- **Telegram bot only responds to `TELEGRAM_AUTHORIZED_CHAT_ID`.** Everything else is silently dropped. ADR-006.
- **No `any`.** Boundary data (webhook bodies, raw tool input) is `unknown`, narrowed with `zod` immediately.
- **Secrets never enter git** — only `.env` (ignored) and Railway variables. Before every commit, check staged files for `.env`, tokens, passwords in connection strings, real chat IDs or health values. ADR-013.
- **OAuth tokens live encrypted in the `oauth_tokens` table**, never env vars; OAuth flows use a single-use `state`. ADR-011.
- **Every webhook is authenticated before it's parsed** (Telegram secret header, Strava verify token + subscription/owner check), timing-safe compare, reject path tested. ADR-012.
- **Literature corpus is open sources, athlete-scanned print copies, or notes only** — never DRM-stripped or pirated files. Source files stay in git-ignored `data/literature/`. ADR-014.
- **Every Telegram message is HTML** (`parse_mode` set by a transformer, ADR-017). Escape all data with `esc()` from `src/bot/html.ts`; model-written text goes through `markdownToHtml`. The plain renderings in `src/agent/` are for the prompt, not for Telegram.
- **`npm run check` (Biome + `tsc --noEmit` + Vitest) must pass before any commit touching `src/`.**

## Stack

TypeScript (strict, ESM) on Node.js 24 LTS · Fastify · Drizzle + Neon Postgres · grammy (Telegram) · `node-cron` (`Europe/Ljubljana`, never a hardcoded offset label) · Biome (lint+format) · Vitest · pino (structured logs, secrets redacted at the logger) · Railway hosting.

## Conventions in one paragraph

One module, one responsibility — no file both queries the DB and formats Telegram output. Named exports only, no barrel files. Custom error classes per failure domain, caught at the boundary (webhook handler / cron job), always resulting in a structured log line **and** a Telegram message to the athlete on failure — that's the entire observability strategy for this project, so it has to actually fire everywhere, not just in the happy-path phases. Co-locate tests (`foo.ts` + `foo.test.ts`), don't mirror a separate `test/` tree.

## Current status

Phase 0 done: repo `mkozmelj/croton-project` (public since 2026-10-01, MIT; see ADR-013), deployed on Railway at `https://croton-project-production.up.railway.app` (`/health` responds). Phase 1 done (bot + Claude wrapper + budget, deployed; prod webhook answers). Phase 2 done (Strava OAuth + webhook via REST, Intervals.icu wellness sync (ADR-015), full schema, activity summaries, `/status`, dynamic context; deployed, Strava connected with a webhook subscription, Intervals.icu syncing). Phase 3 done (fitness baseline per ADR-016, goals, onboarding, weekly plan + Sunday recap, Google Calendar via REST, confirm buttons via `pending_actions`; deployed and acceptance-checked in production). Phase 4 done (literature ingest `npm run ingest` + retrieval eval, in-memory search and the `search_literature` tool for chat and plan generation, 22 sources / 256 chunks, TrainingPeaks 2024 imported via `npm run tp:import`; deployed and acceptance-checked in production). Deferred until the athlete scans the books: book distillation pass and scanned-book ingest. Phase 5 done (model router, monthly conversation memory, token-refresh retry/alert + `/reauth`, `/profile` editing, process-level error alerts + `/selftest`, threshold breakthrough check; deployed and acceptance-checked in production). Phase 6 done (post-activity feedback questions, ADR-018: `activity_feedback` table, one-tap buttons, feedback in context; a matched activity gets the planned title and description on Strava, ADR-019, which needs `/reauth strava` for `activity:write`; deployed and acceptance-checked in production). Use Node 24 (`nvm use`, reads `.nvmrc`).

Local dev (`npm run dev`, `NODE_ENV=development`) uses Telegram long polling, and grammy **deletes the registered webhook** when polling starts — so running dev with the prod bot token silently disconnects production until the next deploy. Use a separate dev bot from BotFather for local work.

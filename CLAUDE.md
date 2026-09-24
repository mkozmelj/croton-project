# Croton Project — Training Agent

Personal AI training coach for a single amateur multi-sport athlete. Telegram bot + Claude API + Strava/Google Calendar/Terra integrations, on a hard €20/month budget.

**Read before touching code:** `spec.md` (vision, architecture, data model) → `docs/00-pre-implementation-review.md` (gaps/corrections) → `docs/02-architecture-decisions.md` (binding decisions — **wins over `spec.md` on conflict**) → `docs/03-build-plan.md` (the actual task list). `docs/01-stack-and-principles.md` has the per-technology conventions below in full detail.

## Non-negotiable rules

- **Single Claude-call wrapper.** Every Claude API call goes through `src/agent/claude.ts`. No other file calls `client.messages.create`/`stream` directly. It owns budget-checking, usage logging, and the cached-system-prompt structure.
- **Model IDs are constants, never inline strings.** `MODELS.sonnet` = `claude-sonnet-5`, `MODELS.haiku` = `claude-haiku-4-5`, defined once in `src/config/env.ts`. See `docs/02-architecture-decisions.md` ADR-001.
- **System prompt caching is structural, not optional.** Static training-principles content first (with `cache_control`, 1h TTL), dynamic athlete/session context appended after. Never interpolate anything dynamic before the cache breakpoint. ADR-004.
- **`conversations.content` is `jsonb`, storing full Anthropic content-block arrays** — not summarized text. Needed to replay `tool_use`/`tool_result` correctly. ADR-003.
- **Every webhook write is an upsert** (`onConflictDoUpdate`), never a plain insert — Strava and Terra both retry webhooks. ADR-009.
- **Telegram bot only responds to `TELEGRAM_AUTHORIZED_CHAT_ID`.** Everything else is silently dropped. ADR-006.
- **No `any`.** Boundary data (webhook bodies, raw tool input) is `unknown`, narrowed with `zod` immediately.
- **Secrets never enter git** — only `.env` (ignored) and Railway variables. Before every commit, check staged files for `.env`, tokens, passwords in connection strings, real chat IDs or health values. ADR-013.
- **OAuth tokens live encrypted in the `oauth_tokens` table**, never env vars; OAuth flows use a single-use `state`. ADR-011.
- **Every webhook is authenticated before it's parsed** (Telegram secret header, Strava verify token + subscription/owner check, Terra HMAC), timing-safe compare, reject path tested. ADR-012.
- **`npm run check` (Biome + `tsc --noEmit` + Vitest) must pass before any commit touching `src/`.**

## Stack

TypeScript (strict, ESM) on Node.js 24 LTS · Fastify · Drizzle + Neon Postgres · grammy (Telegram) · `node-cron` (`Europe/Ljubljana`, never a hardcoded offset label) · Biome (lint+format) · Vitest · pino (structured logs, secrets redacted at the logger) · Railway hosting.

## Conventions in one paragraph

One module, one responsibility — no file both queries the DB and formats Telegram output. Named exports only, no barrel files. Custom error classes per failure domain, caught at the boundary (webhook handler / cron job), always resulting in a structured log line **and** a Telegram message to the athlete on failure — that's the entire observability strategy for this project, so it has to actually fire everywhere, not just in the happy-path phases. Co-locate tests (`foo.ts` + `foo.test.ts`), don't mirror a separate `test/` tree.

## Current status

Phase 0 (repo bootstrap) done locally: tooling, `/health` server, `.env.example`, `railway.json`. Remaining for Phase 0: first push to the private GitHub repo and confirming the Railway deploy. Then Phase 1. Use Node 24 (`nvm use`, reads `.nvmrc`).

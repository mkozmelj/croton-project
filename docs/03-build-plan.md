# Build Plan

Concrete, sequential implementation checklist. Supersedes `spec.md` §13's phase list — same shape, corrected and made actionable using the decisions in `02-architecture-decisions.md`. Each phase ends with a working, testable increment; don't start a phase before the previous one's acceptance criteria pass.

---

## Phase 0: Repo & tooling bootstrap (new — not in original spec)

**Goal:** An empty-but-correctly-configured repo, before any feature code.

- [x] `npm init`, TypeScript strict config per `01-stack-and-principles.md` §2
- [x] Biome config (lint + format, one config file)
- [x] `vitest.config.ts`
- [x] `drizzle.config.ts` pointing at Neon
- [x] `.env.example` with every var from spec.md §9.3, plus `TELEGRAM_AUTHORIZED_CHAT_ID` (ADR-006), `DISABLE_THINKING` (ADR-005), `STRAVA_WEBHOOK_VERIFY_TOKEN` (ADR-012), `TOKEN_ENCRYPTION_KEY` (ADR-011) — and without the per-user OAuth token vars (ADR-011)
- [x] `npm run check` script: `biome check && tsc --noEmit && vitest run`
- [x] GitHub repo created (private — ADR-013), Railway connected, auto-deploy on `main` confirmed working with a placeholder `/health` endpoint
- [x] `CLAUDE.md` in place (see project root)
- [x] `.gitignore` covering `.env*`, `node_modules/`, `dist/`; secrets check before the first commit (ADR-013)

**Acceptance:** `npm run check` passes on an empty project; a trivial Fastify app with `/health` deploys to Railway and responds.

**Manual steps needed:** checklist #1–3, #6 from spec.md §12.1.

---

## Phase 1: Skeleton (telegram + claude, budget-tracked)

**Goal:** Same as spec.md §13 Phase 1, with the corrections baked in from the start.

- [ ] Neon schema: `conversations` (using ADR-003's `jsonb content`), `llm_usage`
- [ ] `src/config/env.ts` — zod-validated env, exports `MODELS` (ADR-001) and re-exports `pricing.ts` (ADR-008)
- [ ] `src/agent/claude.ts` — single wrapper for all Claude calls: budget check → call → usage logging. No other file calls `client.messages.create` directly.
- [ ] `src/agent/budget.ts` — cost tracking + the graduated enforcement from spec.md §8.3, using the pricing table from ADR-008
- [ ] `src/bot/setup.ts` — grammy init; **long-polling in dev, webhook in prod** (env-flag switch, no tunnel needed for local Telegram testing)
- [ ] Telegram access-control middleware (ADR-006) — wired in before any command handler
- [ ] Telegram webhook authenticated with `secret_token` / `X-Telegram-Bot-Api-Secret-Token`, bot token never in the URL (ADR-012)
- [ ] `pino` secret redaction configured (ADR-013) — first phase that handles API keys
- [ ] `DISABLE_THINKING` kill switch in `env.ts` + wrapper (ADR-005); re-derive spec.md §8.4's monthly estimate with thinking tokens included
- [ ] Basic system prompt: static training-principles block only (no dynamic context yet — that's Phase 2+), structured per ADR-004 even though there's nothing dynamic to append yet
- [ ] `/start`, `/budget` commands
- [ ] Deploy to Railway, `setWebhook` call runs automatically on boot in prod mode

**Acceptance:** Message the bot from the authorized chat, get a Claude-generated reply, see a row land in `llm_usage` with the correct model/cost. Message from any other chat produces no reply. `response.usage.cache_read_input_tokens` is non-zero on the second message in a session (verifies ADR-004's caching actually works before more prompt content gets added on top of it).

**Manual steps needed:** spec.md §12.1 #4, #6 (Strava app + Anthropic key — Strava app needed early so Phase 2 isn't blocked waiting on it).

---

## Phase 2: Data layer

**Goal:** Same as spec.md §13 Phase 2, with the MCP-vs-REST decision made first.

- [ ] **MCP spike (ADR-002):** 30-minute check of the two MCP URLs (both already confirmed to exist — `405` on `GET`, 2026-09-23; the authenticated call is what's left). Record the outcome directly in this file (edit this checklist to strike out whichever path isn't used) before writing integration code.
- [ ] `oauth_tokens` table + AES-256-GCM token encryption (`TOKEN_ENCRYPTION_KEY`) (ADR-011)
- [ ] Strava OAuth flow with single-use `state` + token refresh that re-saves both tokens (`src/integrations/strava/oauth.ts`, ADR-011)
- [ ] Strava webhook handler: verify-token handshake, `subscription_id`/`owner_id` check, 200 within 2s + async processing, re-fetch activity via API (ADR-012), upsert-by-`external_id` (ADR-009) — no plain inserts
- [ ] Terra webhook handler: HMAC check on the raw body (ADR-012), upsert-by-`date` (ADR-009)
- [ ] Full schema: `activities`, `health_metrics`, `athlete_profile` (without `race_calendar`), `events`, `goals` (ADR-010, incl. the one-active-A-goal-per-season partial unique index)
- [ ] Activity-summary flow (Haiku, no thinking per ADR-005) → Telegram notification
- [ ] `/status` command
- [ ] Dynamic context block now gets appended to the system prompt (ADR-004's second array element) — re-verify caching still hits on the static portion after this change

**Acceptance:** A real Strava activity (or a simulated webhook payload in a test) produces a Telegram summary within seconds and a correctly-upserted DB row. Health metrics from Terra populate `health_metrics` without duplicate rows on webhook retry.

**Manual steps needed:** spec.md §12.1 #8, §12.2 #9, #12, #13.

---

## Phase 3: Calendar & planning

**Goal:** Same as spec.md §13 Phase 3, with persisted confirmation state.

- [ ] Google Calendar integration (MCP-or-REST, same spike-first approach as Strava if not already resolved); tokens in `oauth_tokens` (ADR-011); OAuth consent screen set to "In production" so refresh tokens don't expire after 7 days
- [ ] `pending_actions` table + minimal state machine (ADR-007)
- [ ] Weekly plan generation prompt chain (Sonnet, adaptive thinking + effort per ADR-005's table)
- [ ] Goal setting via chat → `pending_actions` (`set_goal`) → confirm → write `events` + `goals` (ADR-010); `/goals` command
- [ ] Derive `current_phase` from weeks-to-A-event; inject A goal + upcoming B/C events into the dynamic context block
- [ ] Sunday cron (`node-cron`, explicit `Europe/Ljubljana` timezone — no "CET" string anywhere)
- [ ] Plan → calendar event creation, gated on confirmation via `pending_actions`
- [ ] Mid-week plan adjustment (Sonnet, low effort per ADR-005)
- [ ] `/recap`, `/plan`, `/tomorrow` commands

**Acceptance:** Trigger `/recap` manually, go through the full conversational flow, confirm, and see real events appear on Google Calendar with correct times in local timezone. Kill and restart the process between "plan generated" and "confirmed" — confirming after restart still works (proves ADR-007). Set an A goal and one B goal via chat; `/goals` lists both with correct weeks remaining, a second A goal for the same season is refused with a replace prompt, and the generated plan reflects the phase derived from the A event date.

**Manual steps needed:** spec.md §12.1 #5, §12.2 #10, #11.

---

## Phase 4: Intelligence

**Goal:** Same as spec.md §13 Phase 4, with corpus sourcing and ingestion per ADR-014. The books have no DRM-free ebook editions, so the pipeline is built and validated on the open corpus first, and scanned books are added afterwards.

- [ ] Decide embedding provider (OpenAI vs Voyage) — ADR-014 open question
- [ ] `literature_chunks` schema per ADR-014 (`section`, `locator`, `source_type`, `content_hash`, unique `(source, content_hash)`, `real[]` embedding) + migration
- [ ] `npm run ingest -- <file>` CLI: extract (EPUB/HTML, text PDF, OCR'd scan) → Markdown cleanup → heading-aware chunks with context prefix → batched embeddings logged to `api_usage` → upsert
- [ ] Ingest the open corpus: the six open-access papers listed in ADR-014 plus selected Uphill Athlete / TrainingPeaks / Friel / Fitzgerald articles
- [ ] Retrieval eval fixture (15–20 questions → expected source, top-5 recall), run in Vitest against a small fixture corpus
- [ ] In-memory vector search, loaded at startup
- [ ] `search_literature` tool, wired into the tool set with a prescriptive description (per `01-stack-and-principles.md` §6 — "call this when the athlete asks a specific training-science question not covered by the core principles," not just "searches literature"); exposed to `plan_generation` as well as `knowledge_qa`
- [ ] Book distillation pass: chapter notes → hand-merged updates to `STATIC_SYSTEM_PROMPT` (re-verify cache hits afterwards)
- [ ] Ingest scanned books (*Triathlete's Training Bible*, *Daniels' Running Formula*) once the athlete has scanned them — not a blocker for Phase 4 acceptance
- [ ] Import TrainingPeaks 2024 data

**Acceptance:** Ask a specific training-science question not covered by the core system prompt principles; verify the agent calls `search_literature` and the answer cites something from the ingested corpus (source + locator). The retrieval eval passes. Re-running ingest on the same file creates no duplicate rows.

**Manual steps needed:** spec.md §12.1 #7 (or a Voyage key, depending on the provider decision), §12.2 #14. Plus, from ADR-014: buy print copies of *Triathlete's Training Bible* (5th ed.) and *Daniels' Running Formula* (4th ed.), scan them with an OCR scanning app (~1h per book) into the git-ignored `data/literature/`, and export Kindle highlights for *Your First Triathlon*.

---

## Phase 5: Polish

**Goal:** Same as spec.md §13 Phase 5, reliability items made concrete per `01-stack-and-principles.md` §5.

- [ ] Conversation summarization/cleanup job (monthly, per spec.md §6.2)
- [ ] Model router (`src/agent/classifier.ts`) with the Sonnet-biased heuristic from the review doc (#13) — day-of-week/workout/plan/race keywords force Sonnet regardless of message length
- [ ] Token-refresh retry with backoff + Telegram alert after 3 failures, `/reauth` command
- [ ] `/profile` command
- [ ] `pino` structured logging wired everywhere, with secret redaction configured at the logger level
- [ ] Uncaught-error → Telegram-alert wiring in every webhook handler and cron job (per `01-stack-and-principles.md` §5 — this *is* the observability strategy for this project, make sure it's actually wired everywhere, not just planned)
- [ ] Athlete-profile onboarding flow via chat

**Acceptance:** Force a Strava token to expire and confirm the retry-then-alert path fires correctly. Force an unhandled exception in a webhook handler and confirm a Telegram alert arrives instead of a silent failure.

**Manual steps needed:** spec.md §12.2 #15.

---

## Cross-cutting, done once and never revisited per phase

- `npm run check` must pass before any commit that touches `src/` — this isn't a phase, it's a standing rule from Phase 0 onward.
- Every new table needs a Drizzle migration committed in the same commit as the schema change (per `01-stack-and-principles.md` §4).
- Every new webhook handler follows the upsert pattern from ADR-009 and the authentication rules from ADR-012 from its first commit, not as a follow-up fix.
- No secrets in any commit — check staged files before committing (ADR-013).

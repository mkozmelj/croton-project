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

- [x] Neon schema: `conversations` (using ADR-003's `jsonb content`), `llm_usage` (plus cache-token columns, see ADR-008 notes) — migration `drizzle/0000_*`, applied on boot
- [x] `src/config/env.ts` — zod-validated env, exports `MODELS` (ADR-001). `PRICING` lives in `pricing.ts` and is imported from there, not re-exported (circular import — see ADR-008 notes)
- [x] `src/agent/claude.ts` — single wrapper for all Claude calls: budget check → call → usage logging. No other file calls `client.messages.create` directly.
- [x] `src/agent/budget.ts` — cost tracking + the graduated enforcement from spec.md §8.3, using the pricing table from ADR-008 (threshold alerts fire once, on the call that crosses them)
- [x] `src/bot/setup.ts` — grammy init; **long-polling in dev, webhook in prod** (`NODE_ENV` switch, no tunnel needed for local Telegram testing)
- [x] Telegram access-control middleware (ADR-006) — wired in before any command handler
- [x] Telegram webhook authenticated with `secret_token` / `X-Telegram-Bot-Api-Secret-Token`, bot token never in the URL (ADR-012) — checked in Fastify's `onRequest`, before body parsing
- [x] `pino` secret redaction configured (ADR-013) — redact paths + known secret values scrubbed from error messages/stacks
- [x] `DISABLE_THINKING` kill switch in `env.ts` + wrapper (ADR-005); spec.md §8.4's monthly estimate re-derived in ADR-005
- [x] Basic system prompt: static training-principles block only (no dynamic context yet — that's Phase 2+), structured per ADR-004 even though there's nothing dynamic to append yet
- [x] `/start`, `/budget` commands
- [x] Deploy to Railway, `setWebhook` call runs automatically on boot in prod mode (verified 2026-09-24: `/budget` answers via the prod webhook)

**Acceptance:** Message the bot from the authorized chat, get a Claude-generated reply, see a row land in `llm_usage` with the correct model/cost. Message from any other chat produces no reply. `response.usage.cache_read_input_tokens` is non-zero on the second message in a session (verifies ADR-004's caching actually works before more prompt content gets added on top of it).

**Manual steps needed:** spec.md §12.1 #4, #6 (Strava app + Anthropic key — Strava app needed early so Phase 2 isn't blocked waiting on it).

---

## Phase 2: Data layer

**Goal:** Same as spec.md §13 Phase 2, with the MCP-vs-REST decision made first.

- [x] **MCP spike (ADR-002):** done 2026-09-24, outcome recorded in ADR-002. **Strava: REST** (~~MCP path~~): `mcp.strava.com` authorizes through its own issuer (`www.strava.com/oauth/mcp/*`, dynamic client registration), so the API-app token doesn't apply there, and the webhook flow needs the API-app token anyway. **Google Calendar: MCP viable** (standard `accounts.google.com` OAuth, `initialize` works), decided in Phase 3.
- [x] `oauth_tokens` table + AES-256-GCM token encryption (`TOKEN_ENCRYPTION_KEY`) (ADR-011) — `src/integrations/oauth-crypto.ts`, `src/db/oauth-tokens.ts`; single-use states in `oauth_states`
- [x] Strava OAuth flow with single-use `state` + token refresh that re-saves both tokens (`src/integrations/strava/oauth.ts`, `auth-routes.ts`, ADR-011) — the bot's `/connect` mints the state and sends the link
- [x] Strava webhook handler: verify-token handshake, `subscription_id`/`owner_id` check, 200 within 2s + async processing, re-fetch activity via API (ADR-012), upsert-by-`external_id` (ADR-009) — no plain inserts. Subscription via `npm run strava:subscribe`
- [x] ~~Terra webhook handler~~ → **Intervals.icu wellness sync** (ADR-015: Terra is no longer free): hourly `node-cron` job pulls the last 3 days of Garmin wellness data, upsert-by-`date` (ADR-009), one Telegram alert per failure streak
- [x] Full schema: `activities`, `health_metrics`, `athlete_profile` (without `race_calendar`), `events`, `goals` (ADR-010, incl. the one-active-A-goal-per-season partial unique index) — migration `drizzle/0001_phase2_data_layer.sql`
- [x] Activity-summary flow (Haiku, no thinking per ADR-005) → Telegram notification — summarized once per new activity, plain-text fallback when over budget
- [x] `/status` command
- [x] Dynamic context block now gets appended to the system prompt (ADR-004's second array element) — re-verify caching still hits on the static portion after this change. **Verified 2026-09-24:** call 1 `cache_creation_input_tokens: 2298`, call 2 `cache_read_input_tokens: 2298`, with a fresh context block (~300 tokens) on each call.
- [x] Deploy + connect (done 2026-09-24): set `TOKEN_ENCRYPTION_KEY` in Railway, deploy, `/connect` from Telegram, `npm run strava:subscribe -- create <APP_URL>`, set `STRAVA_SUBSCRIPTION_ID`, redeploy; Intervals.icu: connect Garmin with "Download wellness data" on, set `INTERVALS_API_KEY` + `INTERVALS_ATHLETE_ID`

**Acceptance:** A real Strava activity (or a simulated webhook payload in a test) produces a Telegram summary within seconds and a correctly-upserted DB row. Health metrics from Intervals.icu populate `health_metrics` without duplicate rows when the same days are synced again.

**Manual steps needed:** spec.md §12.2 #9, plus an Intervals.icu account linked to Garmin Connect (replaces §12.1 #8 and §12.2 #12, #13, see ADR-015).

---

## Phase 3: Calendar & planning

**Goal:** Same as spec.md §13 Phase 3, with persisted confirmation state, and plans built on the athlete's real fitness level (ADR-016).

**Fitness baseline first**, before any plan is generated:

- [x] `fitness_markers` table + migration (copies existing `vdot`/`ftp`/`css` in, then drops those columns); `athlete_profile.background` (`jsonb`, zod-validated); `health_metrics.ctl`/`atl`/`ramp_rate` (ADR-016)
- [x] Wellness mapper also maps `ctl`/`atl`/`rampRate` (ADR-015 records, no extra request)
- [x] `intervals-profile` cron job: `GET /api/v1/athlete/{id}` → `sportSettings` thresholds + zones → new marker row only on change, failure-streak alerting as for wellness. Fix units/zone encoding from a real response into a test fixture first
- [x] `src/training/`: VDOT from a race result (Daniels–Gilbert), zone derivation from FTP / LTHR / VDOT / CSS, tested against published tables; `sport_zones` rewritten when a marker changes
- [x] `pending_actions` table + minimal state machine (ADR-007). Needed here already for onboarding writes
- [x] Chat onboarding (`/onboard`, auto-offered from `/start` while `background` is empty): background, recent race results, availability, injuries, missing thresholds → confirm → write (`update_profile`, `add_fitness_marker`)
- [x] Field-test protocols (FTP 20-min, run LTHR 30-min, CSS 400/200) added to `STATIC_SYSTEM_PROMPT` (re-verify cache hits); activity-summary flow proposes a marker when a planned test is completed
- [x] Context: markers with age + source, stale flag (12 weeks, 8 in build/peak), per-sport "no intensity anchor → RPE + schedule a test" line; `weeks` option so plan generation gets 6 weeks of per-sport totals + CTL/ATL/ramp-rate trend + ACWR
- [x] `/profile` command (view only): current markers with date and source, zones, background, missing/stale items

**Planning:**

- [x] Google Calendar integration (MCP-or-REST, same spike-first approach as Strava if not already resolved); tokens in `oauth_tokens` (ADR-011); OAuth consent screen set to "In production" so refresh tokens don't expire after 7 days
- [x] Weekly plan generation prompt chain (Sonnet, adaptive thinking + effort per ADR-005's table); recap opens with any missing or stale fitness markers (ADR-016)
- [x] Goal setting via chat → `pending_actions` (`set_goal`) → confirm → write `events` + `goals` (ADR-010); `/goals` command
- [x] Derive `current_phase` from weeks-to-A-event; inject A goal + upcoming B/C events into the dynamic context block
- [x] Sunday cron (`node-cron`, explicit `Europe/Ljubljana` timezone — no "CET" string anywhere)
- [x] Plan → calendar event creation, gated on confirmation via `pending_actions`
- [x] Mid-week plan adjustment (Sonnet, low effort per ADR-005)
- [x] `/recap`, `/plan`, `/tomorrow` commands

**Acceptance:** Trigger `/recap` manually, go through the full conversational flow, confirm, and see real events appear on Google Calendar with correct times in local timezone. Kill and restart the process between "plan generated" and "confirmed" — confirming after restart still works (proves ADR-007). Set an A goal and one B goal via chat; `/goals` lists both with correct weeks remaining, a second A goal for the same season is refused with a replace prompt, and the generated plan reflects the phase derived from the A event date. After the first `intervals-profile` run, `/profile` shows the FTP / LTHR / threshold pace set in Intervals.icu with today's date and source `intervals`; running the job again adds no rows. Completing onboarding with a recent race result stores a `race` VDOT marker matching Daniels' table. A generated plan uses the athlete's zones (watts / pace / bpm, not generic ones), and with a marker older than 12 weeks, it schedules a field test and says so in the recap.

**Status: done (2026-09-24).** Deployed, and the athlete ran every acceptance check in production: the Intervals.icu import on `/profile` (a second run adds no rows), Google Calendar connected, onboarding with a race VDOT and a stale-marker test, A and B goals with the second-A refusal, `/recap` → restart → Confirm → events in Google Calendar at local times, and a mid-week change. Google Calendar is REST (ADR-002, Phase 3 decision). Mid-week changes go through the `chat` call (same Sonnet/low policy as `plan_adjustment`) with the `propose_week_plan` tool until the Phase 5 router exists.

**Manual steps needed:** spec.md §12.1 #5, §12.2 #10, #11, and §12.2 #15 (moved here from Phase 5: done through the chat onboarding). In Intervals.icu, check that FTP / LTHR / threshold pace / max HR are current in Settings → sport settings, and enable Garmin **activity** sync as well as wellness so CTL covers every activity (ADR-016). Google Cloud (done): OAuth client of type "Web application" with redirect URI `<APP_URL>/auth/google/callback` (add `http://localhost:3000/auth/google/callback` to connect from dev), no JavaScript origins. **Enable the Google Calendar API**: without it every insert returns 403. Branding needs a homepage and privacy policy URL before the app can be published, served by the app itself (`/`, `/privacy`, `src/pages.ts`), with the full Railway hostname as the authorized domain. Consent screen **published "In production"** (in "Testing", only listed test users can connect, and refresh tokens expire after 7 days). Then set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in Railway, deploy, and send `/connect calendar` (click through the "unverified app" warning once).

---

### Phase 3 follow-ups (2026-09-24)

- [x] `intervals-profile` weekly (Sunday 18:30) + on boot + refreshed before each plan generation (ADR-016 notes)
- [x] Body composition from the Intervals.icu wellness fields (iOS Shortcut): weekly averages and 4-week change in the context and `/profile`, W/kg next to FTP (ADR-015 note)
- [x] `/import`: 12 months of Strava activities (insert-only, no notifications) + 90 days of wellness; plan generation gets 12 months of monthly totals and peaks per sport

**After deploying:** send `/import` once and check that `/profile` shows the body-composition weeks and W/kg.

---

## Phase 4: Intelligence

**Goal:** Same as spec.md §13 Phase 4, with corpus sourcing and ingestion per ADR-014. The books have no DRM-free ebook editions, so the pipeline is built and validated on the open corpus first, and scanned books are added afterwards.

- [x] Decide embedding provider: OpenAI `text-embedding-3-small` (ADR-014, 2026-09-26); key set in `.env` and Railway
- [x] `literature_chunks` schema per ADR-014 (`section`, `locator`, `source_type`, `content_hash`, unique `(source, content_hash)`, `real[]` embedding, `embedding_model`) + migration
- [x] `npm run ingest -- <file>` CLI: extract (EPUB/HTML, JATS XML, text PDF, OCR'd scan) → Markdown cleanup → heading-aware chunks with context prefix → batched embeddings logged to `llm_usage` → upsert (`src/knowledge/`; `--dry-run` prints the chunks, `--list` the sources)
- [x] Ingest the open corpus. Done: Stöggl & Sperlich 2014, Gabbett 2016. Seiler 2010, Bosquet 2007 and Plews 2013 turned out not to be open access, and Impellizzeri et al. 2020 (J Athl Train) is free to read but not downloadable through the API (see ADR-014). Articles (2026-09-26): 12 ingested from TrainingPeaks, Friel, 80/20 Endurance and Scientific Triathlon (list and URLs in the git-ignored `data/literature/articles/manifest.tsv`). The 7 Uphill Athlete articles came through their public WordPress REST API (`/wp-json/wp/v2/posts?slug=…`, 5 s apart per their robots.txt crawl delay), because the HTML pages block scripted downloads. 22 sources, 256 chunks in total
- [x] Retrieval eval fixture (15–20 questions → expected source, top-5 recall), run in Vitest against a small fixture corpus (`src/knowledge/retrieval-eval.test.ts`; 18 questions, recall@5 1.00; `npm run eval:embed` refreshes the cached vectors after a chunking change)
- [x] In-memory vector search, loaded at startup (reloads when an ingest changes the table)
- [x] `search_literature` tool, wired into the tool set with a prescriptive description (per `01-stack-and-principles.md` §6 — "call this when the athlete asks a specific training-science question not covered by the core principles," not just "searches literature"); exposed to `plan_generation` as well as `knowledge_qa`
- [ ] Book distillation pass: chapter notes → hand-merged updates to `STATIC_SYSTEM_PROMPT` (re-verify cache hits afterwards). Deferred with the scanned books; not a blocker for Phase 4 acceptance
- [ ] Ingest scanned books (*Triathlete's Training Bible*, *Daniels' Running Formula*) once the athlete has scanned them — not a blocker for Phase 4 acceptance
- [x] Import TrainingPeaks 2024 data (`npm run tp:import`, `src/integrations/trainingpeaks/`): 93 completed workouts from 2024-06-01 to 2024-09-07 in `activities`, and the plan as weekly notes in the literature corpus. The export lives in git-ignored `data/trainingpeaks/`

**Acceptance:** Ask a specific training-science question not covered by the core system prompt principles; verify the agent calls `search_literature` and the answer cites something from the ingested corpus (source + locator). The retrieval eval passes. Re-running ingest on the same file creates no duplicate rows.

**Accepted 2026-09-26 in production.** "What does the research say is the best way to increase VO2max?" triggered `search_literature` (logged in `conversations` and as an embedding row in `llm_usage`), and the answer cited Stöggl & Sperlich 2014 with page locators. The retrieval eval passes (recall@5 1.00), and re-ingesting reported 0 embedded / all unchanged. Deferred to after the athlete scans the books: book distillation and scanned-book ingest.

**Manual steps needed:** spec.md §12.2 #14 (§12.1 #7, the OpenAI key, is done). Plus, from ADR-014: buy print copies of *Triathlete's Training Bible* (5th ed.) and *Daniels' Running Formula* (4th ed.), scan them with an OCR scanning app (~1h per book) into the git-ignored `data/literature/`, and export Kindle highlights for *Your First Triathlon*.

---

## Phase 5: Polish

**Goal:** Same as spec.md §13 Phase 5, reliability items made concrete per `01-stack-and-principles.md` §5.

- [x] Conversation summarization/cleanup job (monthly, per spec.md §6.2): `conversation-memory` cron (1st of the month, 03:30). Turns older than 60 days are summarized on Haiku (`conversation_summary`) into `conversation_memories` (migration `0005`) and then deleted. The last 6 notes go into the dynamic context. It's idempotent on the last summarized turn id, and over budget it keeps the turns for next month (`src/agent/memory.ts`)
- [x] Model router (`src/agent/classifier.ts`) with the Sonnet-biased heuristic from the review doc (#13): day-of-week/workout/plan/race keywords force Sonnet regardless of message length. A Haiku-routed call that tries to propose a week plan is redone on Sonnet. `/deep` forces Sonnet (details in the ADR-005 implementation notes)
- [x] Token-refresh retry with backoff + Telegram alert after 3 failures, `/reauth` command (`src/integrations/token-refresh.ts`, ADR-011 implementation notes)
- [x] `/profile` editing: `/profile ftp 250`, `/profile pace 4:15`, `/profile availability …` and so on, confirmed with a button; `/profile help` lists them (`src/agent/profile-edit.ts`)
- [x] `pino` structured logging wired everywhere, with secret redaction configured at the logger level. This was done in Phase 1; Phase 5 adds camelCase token fields to the redaction paths and a request serializer that drops query strings (OAuth `code`/`state`, the Strava verify token). `console` is only used by the CLIs
- [x] Uncaught-error → Telegram-alert wiring in every webhook handler and cron job. Audit: the Telegram updates go through the grammy error boundary, Fastify routes through the 5xx error handler, Strava events through the background-task runner, and cron jobs through `guardedJob`. New: the `unhandledRejection` / `uncaughtException` handlers (`src/utils/process-guards.ts`), an alert when startup fails, and a hidden `/selftest` command that fails on purpose
- [x] Threshold breakthrough check: an activity clearly beating a marker (e.g. 20-min power > 105% FTP, a run faster than predicted by VDOT) proposes a marker update (ADR-016). Implemented with a 3% margin; the ADR-016 implementation notes explain why that's stricter than the 105% example (`src/training/breakthroughs.ts`)

**Acceptance:** Force a Strava token to expire and confirm the retry-then-alert path fires correctly. Force an unhandled exception in a webhook handler and confirm a Telegram alert arrives instead of a silent failure.

**Status: done (2026-09-27).** Deployed, and the athlete ran the acceptance checks below in production and reported them passing. `npm run check` passes (411 tests). Unit tests cover the retry path, since Strava's token endpoint can't be made to return 5xx on purpose: 503 three times → one "unavailable" alert, tokens unchanged; 502, 502, 200 → recovers silently; 400 → no retry, one "rejected" alert.

**Acceptance checks (run in production, 2026-09-27):**
1. **Refresh works after expiry:** in the Neon SQL editor, `UPDATE oauth_tokens SET expires_at = now() - interval '1 hour' WHERE provider = 'strava';` then send `/import`. It should report activities, and `expires_at` should be about 6 hours ahead again.
2. **Refresh failure alerts:** expire the token again as in step 1, set `STRAVA_CLIENT_SECRET` to a wrong value in Railway (a redeploy follows), and send `/import`. Strava rejects the refresh, and one "Strava rejected the access renewal … /reauth strava" message arrives. `/import` a second time sends no second alert (one per streak). Then restore the real secret. No `/reauth` is needed afterwards, because the stored refresh token was never replaced.
3. **Unhandled exception in a webhook handler:** send `/selftest`. You should get "Self-test: …", then "Background task selftest failed. It's logged." (the background-task boundary) and "Something broke while handling that message …" (the update handler's boundary). Railway logs show both errors with `module` fields.

**Manual steps needed:** none (migration `0005` runs on boot).

---

## Cross-cutting, done once and never revisited per phase

- `npm run check` must pass before any commit that touches `src/` — this isn't a phase, it's a standing rule from Phase 0 onward.
- Every new table needs a Drizzle migration committed in the same commit as the schema change (per `01-stack-and-principles.md` §4).
- Every new webhook handler follows the upsert pattern from ADR-009 and the authentication rules from ADR-012 from its first commit, not as a follow-up fix.
- No secrets in any commit — check staged files before committing (ADR-013).

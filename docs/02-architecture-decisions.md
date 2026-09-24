# Architecture Decisions

ADR-style log of decisions that correct or sharpen `spec.md`. Each entry: the problem, the decision, and why. Where this doc and `spec.md` disagree, **this doc wins** — `spec.md` stays as the original vision document rather than being edited in place.

---

## ADR-001: Model IDs and version pinning

**Problem:** `spec.md` names "Sonnet 4.6" / "Haiku 4.5" with stale pricing (see review doc #1).

**Decision:**
- Use `claude-sonnet-5` (not `claude-sonnet-4-6`) and `claude-haiku-4-5` (unchanged).
- Pin both as named constants in `src/config/env.ts`:
  ```ts
  export const MODELS = {
    sonnet: "claude-sonnet-5",
    haiku: "claude-haiku-4-5",
  } as const;
  ```
- Current pricing (per MTok, for budget calculations): Sonnet 5 — $3.00 in / $15.00 out. Haiku 4.5 — $1.00 in / $5.00 out. Re-derive spec.md §8.4's cost estimates against these figures once ADR-005's thinking policy is applied — thinking tokens count as output tokens and will push per-interaction cost above the spec's original estimates for Sonnet-tier calls.
- Upgrade path: when Anthropic ships a new model, bump the constant, re-run the budget estimate, and re-check this ADR's cost table — never scatter model ID strings through call sites, so an upgrade is a one-line change plus a cost re-check, matching spec.md §9.3's env-var-driven philosophy but formalized as a code constant instead (env-var overrides are unnecessary complexity for a single-operator app — a code change + redeploy is fine).

---

## ADR-002: MCP-first, but verify before committing

**Problem:** `spec.md` §2.2/§7 assumes `https://mcp.strava.com/mcp` and a Google Calendar MCP endpoint exist and are usable with a bearer token via the Messages API `mcp_servers` parameter. The *mechanism* is real (Anthropic's MCP connector: `mcp_servers` + a paired `mcp_toolset` tool entry + beta header `mcp-client-2025-11-20`) — whether these *specific* third-party servers exist at those URLs was not verified in this review.

**Decision:**
- Phase 2 of the build plan starts with a 30-minute spike: attempt a real `mcp_servers` call against each URL with a valid OAuth token. Three outcomes:
  1. **Works** → build the MCP integration path per the corrected snippet below.
  2. **404 / doesn't exist** → skip MCP entirely for that provider, go straight to REST + custom tools. Do not maintain a dead MCP code path "for later."
  3. **Exists but auth/behavior differs from assumed** → adjust the snippet, still prefer it over REST if it works.
- Corrected request shape (what spec.md's snippet was missing):
  ```ts
  client.beta.messages.create({
    model: MODELS.sonnet,
    betas: ["mcp-client-2025-11-20"],
    mcp_servers: [{
      type: "url",
      url: "https://mcp.strava.com/mcp",
      name: "strava",
      authorization_token: stravaAccessToken,
    }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "strava" }],
    // ...
  });
  ```
- **Status (2026-09-23):** a plain `GET` to both `https://mcp.strava.com/mcp` and `https://calendarmcp.googleapis.com/mcp/v1` returns `405 Method Not Allowed` — the servers exist (MCP endpoints only accept `POST` JSON-RPC). So outcome 1 or 3, not 2. The authenticated spike at the start of Phase 2 still decides between MCP and REST.
- **Spike outcome (2026-09-24):**
  - **Strava → REST.** `https://mcp.strava.com/.well-known/oauth-protected-resource` names `https://www.strava.com/mcp-issuer` as its authorization server, with separate `/oauth/mcp/authorize`, `/oauth/mcp/token` and `/oauth/mcp/register_client` (dynamic client registration) endpoints. Using it would mean a second OAuth grant from a second issuer, refreshed separately, on top of the API-app grant the webhook needs anyway (push subscriptions belong to the API app, and ADR-012 re-fetches every activity with its token). Activities are already in the DB, so the agent reads them from there. Not verified: whether the MCP server also accepts an API-app token was not tested, because building a second grant path for it isn't worth it either way.
  - **Google Calendar → MCP viable.** An unauthenticated `initialize` succeeds; the protected-resource metadata points at `https://accounts.google.com/` with the standard `calendar*` scopes, so the token from our own Google OAuth client should work as the `authorization_token`. Phase 3 confirms it with a real call before building on it.
- Either path (MCP or REST) exposes the same tool-call surface to the agent orchestrator — the integration layer is swappable, matching spec.md's original intent. The only change is *when* the fallback decision gets made: at the start of Phase 2, not reactively when something breaks in Phase 3.

---

## ADR-003: Conversation storage stores full content blocks, not plain text

**Problem:** `conversations.content: text` can't round-trip `tool_use`/`tool_result` blocks needed to correctly replay a multi-turn conversation (review doc #4).

**Decision:** Change the schema:
```
conversations
├── id: serial PK
├── role: text                    # 'user' | 'assistant'
├── content: jsonb                # full Anthropic content-block array, exactly as sent/received
├── telegram_message_id: bigint
├── tokens_used: int
├── model: text
├── created_at: timestamp
```
When building history for a new API call, deserialize `content` directly back into `MessageParam[]` — no re-serialization or summarization at the storage layer. Human-readable text (for `/plan`-style commands that display past messages) is derived from the `text`-type blocks in `content` at render time, not stored separately. This keeps one source of truth instead of two representations drifting apart.

---

## ADR-004: System prompt caching — split static from dynamic

**Problem:** Spec.md §5.1 interpolates dynamic athlete context *before* the static training-principles block in the system prompt, which breaks prompt caching entirely (review doc #7) — caching is a strict prefix match, so anything dynamic ahead of the static block invalidates it on every call.

**Decision:** Structure `system` as an array with the static content first and a cache breakpoint at its end:
```ts
system: [
  {
    type: "text",
    text: STATIC_SYSTEM_PROMPT, // role + training principles + tool descriptions + behavior rules, ~3-4K tokens, never changes at runtime
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
  {
    type: "text",
    text: buildDynamicContext(athleteProfile, currentPlan, recentActivities, healthMetrics), // changes every call
  },
],
```
- **1-hour TTL, not the 5-minute default.** The athlete messages sporadically (a few times a day at most, sometimes gaps of many hours) — a 5-minute cache would cold-write on almost every real interaction. The 1-hour TTL's higher write cost (2x vs 1.25x) pays off at ~3 reads, which is the realistic pattern for a day with a couple of messages plus an activity-summary webhook or two.
- Sonnet 5's minimum cacheable prefix is 1,024 tokens — the ~3-4K token static block clears that comfortably.
- **Haiku 4.5's minimum is 4,096 tokens** (added 2026-09-24, Phase 1). The Phase 1 static prompt measures 2,204 tokens on Sonnet 5 and 1,557 on Haiku 4.5 (`count_tokens`), so **Haiku calls do not cache at all** — a 1h write is attempted, silently skipped, and billed as plain input. Harmless at Haiku prices (activity summaries, quick chat), but it means ADR-004's savings only apply to Sonnet calls until the static block grows past ~4K Haiku tokens (Phase 4's book distillation will likely get it there). It is also why Phase 1 chat runs on Sonnet (ADR-005, `chat` row): the Phase 1 acceptance check is a cache read on the second message.
- **Verified 2026-09-24:** two consecutive Sonnet calls through `src/agent/claude.ts` → call 1 `cache_creation_input_tokens: 2198` (all 1h), call 2 `cache_read_input_tokens: 2198`.
- `STATIC_SYSTEM_PROMPT` must be byte-identical across calls: no timestamps, no non-deterministic serialization anywhere in that string. Verify with `response.usage.cache_read_input_tokens` during Phase 1 smoke-testing — if it's zero after the second call in a session, something in the "static" block isn't actually static.

---

## ADR-005: Thinking and effort policy per call type

**Problem:** Sonnet 5 runs adaptive thinking by default (review doc #8), which spec.md's budget model (§8.4) didn't account for. Left undecided per call type, real spend drifts unpredictably from the estimate.

**Decision (confirmed 2026-09-23): adaptive thinking on for the high-value Sonnet call types, with a kill switch.**

| Classification | Model | Thinking | Effort | Rationale |
|---|---|---|---|---|
| `chat` (Phase 1–4: every free-text message, until the Phase 5 router exists) | Sonnet | adaptive (on) | `low` | No classifier yet, so review doc #13's "default to Sonnet when uncertain" applies to everything. Low effort keeps day-to-day chat cheap. Retired or re-pointed when the router lands. |
| `plan_generation` (Sunday recap) | Sonnet | adaptive (on) | `medium` | Highest-stakes output of the week; quality matters more than the marginal cost here. |
| `plan_adjustment` | Sonnet | adaptive (on) | `low` | Usually a bounded, well-specified edit ("move Thursday's run") — doesn't need deep reasoning. |
| `analysis` | Sonnet | adaptive (on) | `medium` | Trend analysis benefits from actually reasoning through the data. |
| `quick_chat` | Haiku | n/a (unsupported) | n/a | Haiku has no thinking/effort controls — nothing to configure. |
| `activity_summary` | Haiku | n/a | n/a | Same. |
| `knowledge_qa` | Haiku (+RAG) | n/a | n/a | Same. |

**Kill switch:** `DISABLE_THINKING=true` in env (validated in `src/config/env.ts`) makes `src/agent/claude.ts` send `thinking: {type: "disabled"}` and drop `effort` on every Sonnet call — flip it in Railway's variables if thinking tokens are eating the monthly budget, no code change or redeploy of new code needed. The per-row policy above lives only inside the wrapper, per the stack doc's "one wrapper for all Claude calls" convention.

**Re-derived monthly estimate (2026-09-24, replaces spec.md §8.4).** Prices from `src/config/pricing.ts` converted at `USD_TO_EUR = 0.92`: Sonnet 5 €2.76 in / €13.80 out / €5.52 1h cache write / €0.28 cache read per MTok; Haiku 4.5 €0.92 in / €4.60 out. Static prefix measured at 2.2K tokens. Thinking token counts are assumptions (low ≈ 0.5–1K, medium ≈ 2–4K per call) — check them against real `llm_usage.output_tokens` after a few weeks.

| Interaction | Model / effort | Tokens: uncached in + cached in / out (visible + thinking) | Est. cost |
|---|---|---|---|
| Chat message | Sonnet / low | 3K + 2.2K / 0.4K + 0.7K | ~€0.024 |
| Sunday recap + plan | Sonnet / medium | 13K + 2.2K / 3K + 4K | ~€0.13 |
| Plan adjustment | Sonnet / low | 8K + 2.2K / 1.5K + 1K | ~€0.057 |
| Analysis | Sonnet / medium | 8K + 2.2K / 1K + 3K | ~€0.077 |
| Activity summary | Haiku / none (no caching, see ADR-004) | 3K / 0.3K | ~€0.004 |
| Cold cache write | Sonnet 1h write, ~1 per active day | 2.2K | ~€0.012 |

Typical month: 60 chats €1.44 + 4 recaps €0.52 + 8 adjustments €0.46 + 8 analyses €0.62 + 20 summaries €0.08 + 30 cold writes €0.37 ≈ **€3.50** (spec.md's €1.14 was ~3× low, mostly thinking tokens and all-Sonnet chat). If thinking runs at double the assumption: ~€6. Both are well under the €14 cap, so thinking stays on; `DISABLE_THINKING` is the lever if real numbers drift toward the 75% alert. Once the Phase 5 router moves most chat to Haiku, the chat line drops to ~€0.4/month.

---

## ADR-006: Telegram access control

**Problem:** No allowlist on who can message the bot (review doc #6).

**Decision:** Add `TELEGRAM_AUTHORIZED_CHAT_ID` to env config. Every incoming update is checked against it in the grammy middleware chain, before any handler runs; anything else is silently dropped (no reply — don't confirm to a stranger that the bot exists and is listening). Get the chat ID once via `/start` in Phase 1 and hardcode it into the env var — no dynamic multi-user support, matching spec.md's single-athlete scope.

---

## ADR-007: Pending-action state is persisted, not in-memory

**Problem:** The Sunday-recap confirmation flow ("want me to book these on your calendar?") has a window where state must survive a process restart (review doc #5).

**Decision:** Add a minimal table:
```
pending_actions
├── id: serial PK
├── chat_id: bigint
├── action_type: text        # 'book_calendar' | ... (extensible, but start with just this one)
├── payload: jsonb           # the generated plan awaiting confirmation
├── created_at: timestamp
├── expires_at: timestamp    # e.g. 24h — a stale confirmation shouldn't fire days later
```
On bot startup, don't try to resume mid-flow conversationally — if a pending action's `expires_at` has passed, just drop it silently; the athlete can re-trigger `/recap`. This keeps the state machine trivial (one row, checked on the next message from that chat) rather than building a general workflow engine for a single two-step flow.

---

## ADR-008: Budget enforcement uses a data-driven pricing table

**Problem:** Spec.md §8.2 hardcodes per-model pricing inline in `calculateCost()`. Every model price change (and there will be more, per ADR-001) means a code edit.

**Decision:** Pricing lives in `src/config/pricing.ts` as a plain exported object keyed by the same model constants from ADR-001, imported by both the cost calculator and any future admin/`​/budget` display code. Still a code file, not a DB table or remote config — a single-operator app doesn't need runtime-configurable pricing, just a change that's easy to find and impossible to miss when a model is bumped (co-locate with `MODELS` in the same review).

**Implementation notes (Phase 1):**
- `pricing.ts` imports `MODELS` from `env.ts`; `env.ts` does **not** re-export `PRICING` (the build plan's original wording). A re-export would make the two modules import each other, and `PRICING`'s computed keys would read `MODELS` before it's initialized. Import `PRICING` from `src/config/pricing.ts` directly.
- The table also holds the cache multipliers (1h write 2×, 5m write 1.25×, read 0.1×) and a fixed `USD_TO_EUR` rate (0.92, deliberately on the high side so tracked spend errs toward overestimating). `llm_usage` stores `cache_creation_input_tokens` / `cache_read_input_tokens` next to the plain token counts, so cost and cache behaviour can be audited per call.
- Sonnet 5 is priced at $3 / $15 per ADR-001 (post-intro-discount). Some reference tables still list the $2 / $10 intro price; if the console bill shows the lower rate, `llm_usage` is over-counting by ~33%, which is the safe direction.

---

## ADR-009: Webhook idempotency

**Decision:** No change from spec.md's implicit design — it's already correct. `activities.external_id UNIQUE` and `health_metrics.date UNIQUE` mean a retried Strava webhook, or an Intervals.icu sync re-reading days it already stored (ADR-015), naturally upserts rather than duplicating. Make this explicit in the build plan: every webhook handler uses `ON CONFLICT DO UPDATE` (Drizzle's `.onConflictDoUpdate()`), never a plain insert, even on the very first implementation — don't add idempotency later as a fix.

---

## ADR-010: Season goals are first-class, anchored to dated events

**Problem:** Spec.md §4.1 models races as an untyped `race_calendar: jsonb` on `athlete_profile`, and §5.2 says the annual plan is "anchored to target races" — but nothing defines how a goal is set, how a main goal differs from a minor one, or how the agent derives `current_phase` from them. Periodization (base → build → peak → taper) is back-planned from the main event's date, so this is the input the whole plan hangs on and needs to be explicit.

**Decision:** Replace `athlete_profile.race_calendar` with two tables. Every goal is linked to a dated event.
```
events
├── id: serial PK
├── name: text                # e.g. 'Ironman 70.3 Pula'
├── date: date                # race day (local date, Europe/Ljubljana)
├── sport: text               # 'triathlon' | 'run' | 'trail_run' | 'bike' | 'swim' | ...
├── distance: text            # free text: '70.3', 'half marathon', '42 km / 2500 m D+'
├── location: text?
├── calendar_event_id: text?  # Google Calendar event, if booked
├── created_at / updated_at: timestamp

goals
├── id: serial PK
├── event_id: int FK → events.id (NOT NULL)
├── season: int               # e.g. 2027
├── priority: text            # 'A' (main) | 'B' | 'C' (minor)
├── goal_type: text           # 'finish' | 'time' | 'placing' | 'pb'
├── target: text?             # e.g. '4:45:00', 'top 10 AG' — human-readable
├── target_seconds: int?      # parsed time target, when goal_type = 'time'
├── notes: text?              # why this goal matters, constraints
├── status: text              # 'active' | 'achieved' | 'missed' | 'dropped'
├── result: text?             # filled in after the event
├── created_at / updated_at: timestamp
```
- **Priority follows Friel's A/B/C race convention:**
  - **A — main goal.** Exactly one active A goal per season (partial unique index on `(season) WHERE priority = 'A' AND status = 'active'`). The macrocycle is back-planned from its event date: taper → peak → build → base. `current_phase` is *derived* from weeks-to-A-event, not set by hand.
  - **B — minor goal, prioritized.** Gets a short mini-taper (2–4 days reduced volume) but doesn't reshape the macrocycle. Good as tune-up races 4–8 weeks before the A event.
  - **C — minor goal, train-through.** No taper; treated as a hard workout in that week's plan.
- **How goals get set:** by the athlete via Telegram chat ("my main goal for 2027 is sub-4:45 at 70.3 Pula on 2027-09-26"). The agent parses it into a proposed `events` + `goals` row and confirms before writing, via a `pending_actions` row (`action_type: 'set_goal'`, ADR-007) — same confirm-before-write rule as calendar bookings. A `/goals` command lists the season's goals with weeks remaining to each.
- **Validation (zod, at the tool boundary):** event date must be in the future when creating; rejecting a second active A goal returns a message asking whether to replace the existing one rather than failing silently.
- **Prompt placement:** goals go in the **dynamic** context block (ADR-004), never the static cached prefix — they change, and a goal edit must not invalidate the cache. Inject: the A goal with weeks-to-event and derived phase, plus upcoming B/C events in the next 12 weeks.
- **After the event:** the activity-summary flow checks whether a new activity falls on an event date and, if so, asks for the result and updates `status`/`result`. After an A event, the plan moves into the transition/recovery phase (spec.md §5.2).

---

## ADR-011: OAuth tokens live in the database, not in env vars

**Problem:** spec.md §9.3 lists `STRAVA_ACCESS_TOKEN`, `STRAVA_REFRESH_TOKEN`, `GOOGLE_ACCESS_TOKEN` and `GOOGLE_REFRESH_TOKEN` as env vars "set after initial OAuth" (while §7.1 says the backend "stores tokens in DB" — the spec contradicts itself). Env vars can't work: Strava access tokens expire after 6 hours and **a refresh can return a new refresh token that replaces the old one** — the app has no way to write that back into Railway's variables, so the integration would silently die after the first rotation.

**Decision:**
- Env holds only the *app* credentials: `STRAVA_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`. The four per-user token vars are removed from `.env.example`.
- Per-user tokens go in a table, one row per provider:
  ```
  oauth_tokens
  ├── provider: text PK          # 'strava' | 'google'
  ├── access_token: text         # encrypted (see below)
  ├── refresh_token: text        # encrypted
  ├── expires_at: timestamptz
  ├── scope: text
  ├── created_at / updated_at: timestamp
  ```
  Every refresh upserts the row with *both* returned tokens (ADR-009 style) — never assume the refresh token is unchanged.
- **Encrypted at rest with AES-256-GCM** using `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64, env only). Neon already encrypts its disks; this additionally means a leaked `DATABASE_URL` or DB dump doesn't hand out a Google Calendar write token. ~30 lines in `src/integrations/oauth-crypto.ts` using `node:crypto`, with a test.
- **OAuth `state` is mandatory.** `/auth/<provider>/start` isn't a public link: the bot sends it (from `/start` onboarding or `/reauth`) with a random single-use `state` stored server-side with a 10-minute expiry. The callback rejects any unknown/expired `state` — otherwise anyone who finds the URL could link *their* Strava/Google account to the bot.
- **Implementation notes (Phase 2):** `oauth_tokens` also has `account_id` (the provider's id for the athlete; for Strava it's the webhook `owner_id` check in ADR-012). States live in `oauth_states` (`state` PK, `provider`, `expires_at`) and are consumed with a single `DELETE … RETURNING`, so a replayed callback fails. Stored ciphertext format: `v1.<iv>.<tag>.<ciphertext>` (base64url), the version prefix leaving room for key rotation. In dev without `APP_URL` the callback is `http://localhost:<PORT>/auth/strava/callback` (Strava always accepts localhost).
- **Google-specific:** while the Google Cloud OAuth consent screen is in "Testing" status, refresh tokens expire after 7 days. Set the app to "In production" (it stays unverified — fine for a single user who clicks through the warning once) before relying on it in Phase 3.

---

## ADR-012: Every inbound webhook is authenticated before it is parsed

**Problem:** spec.md §6.5 says the backend "verifies [the Strava] webhook signature" — Strava webhooks aren't signed. §7.4 says Terra is verified "using dev ID" — Terra signs with the signing secret, not the dev ID. The Telegram webhook's authentication isn't specified at all.

**Decision — per provider:**
| Provider | Mechanism | Env |
|---|---|---|
| Telegram | `setWebhook` with `secret_token`; reject any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match (grammy's `webhookCallback` `secretToken` option). The webhook path is a fixed `/webhook/telegram` — **never put the bot token in the URL** (it would land in access logs). | `TELEGRAM_WEBHOOK_SECRET` |
| Strava | No payload signature exists. Subscription handshake: answer the `GET` with `hub.challenge` only if `hub.verify_token` matches. Events: accept only if `subscription_id` matches our stored subscription and `owner_id` matches the athlete; then **re-fetch the activity from the Strava API** by id instead of trusting the payload. Respond `200` immediately and process async — Strava requires a response within 2 seconds. | `STRAVA_WEBHOOK_VERIFY_TOKEN` |
| ~~Terra~~ | Removed with Terra itself (ADR-015). Health data is now pulled from Intervals.icu with an API key, so there is no inbound health webhook to authenticate. | — |

**Implementation notes (Phase 2):**
- **Strava event checks** need the parsed body (the ids are in it), so the order is: parse JSON → zod → `subscription_id` / `owner_id` check → 200 → async processing. The verify-token handshake is checked before anything else. `STRAVA_SUBSCRIPTION_ID` unset = every event rejected.
- Routes that carry secrets in the query string (`/auth/strava/callback`'s `code`, the Strava handshake's `hub.verify_token`) log at `warn` only, so Fastify's per-request info line never writes them.

**Rules for all of them:** compare secrets with `crypto.timingSafeEqual`, never `===`. On failure, respond `401` with an empty body and log a warning (no Telegram alert — random scanners would spam it). Authentication happens before `zod` parsing and before any DB write. Each handler gets a test for the reject path, not just the happy path.

---

## ADR-013: Secrets never enter the repository

**Problem:** The repo holds the full spec and personal training-data design; one careless commit of `.env`, a pasted token in a doc, or a debug log with an API key would leak credentials that can spend money (Anthropic, OpenAI) or write to the athlete's calendar.

**Decision:**
- **Source of truth for secrets:** local `.env` (git-ignored) for dev, Railway service variables for prod. Nothing else. `.env.example` lists every variable with an empty value and a comment — never a real or realistic-looking value.
- **`.gitignore`** covers `.env` and `.env.*` (except `.env.example`), `node_modules/`, `dist/`, `coverage/`, logs.
- **Before every commit:** check `git status`/`git diff --cached` for `.env` files, tokens (`sk-ant-`, `sk-`, `npg_`, `ghp_`, bot tokens `<digits>:<35 chars>`), connection strings with passwords, and real chat IDs or personal health values in docs/fixtures. Test fixtures use obviously fake data.
- **Logs:** `pino` redaction (stack doc §5) is configured in Phase 1, the first phase that handles secrets — not deferred to Phase 5.
- **If a secret is ever committed:** rotate it at the provider first, then clean history. Removing the file in a later commit doesn't un-leak it.
- The GitHub repo stays **private**.

---

## ADR-014: Literature corpus — sourcing and ingestion

**Problem:** spec.md Appendix B lists the core books as "Requires digital copy" and §5.3 assumes they can be dropped into `data/literature/` as files. A retailer check (2026-09-24) found that no DRM-free EPUB exists for any of them:

| Book | Publisher | Legal ebook editions found |
|---|---|---|
| Friel, *The Triathlete's Training Bible* (5th ed.) | VeloPress | Kindle; ebooks.com (Adobe DRM); B&N; OverDrive lending |
| Friel, *Your First Triathlon* (2nd ed., owned on Kindle) | VeloPress | Kindle; Kobo EPUB; OverDrive |
| Daniels, *Daniels' Running Formula* (4th ed.) | Human Kinetics | Publisher direct = VitalSource online access only (no file); Kobo EPUB with Adobe DRM |
| Bompa, *Periodization* (6th ed.) | Human Kinetics | VitalSource online access only |
| Fitzgerald & Warden, *80/20 Triathlon* | Hachette | Kindle; Kobo; Google Play; OverDrive (DRM status not confirmed, almost certainly DRM) |
| House, Johnston & Jornet, *Training for the Uphill Athlete* | Patagonia | Kobo EPUB with Adobe DRM; Kindle; Everand |
| Allen, Coggan & McGregor, *Training and Racing with a Power Meter* (3rd ed.) | VeloPress | Kobo; Google Play; ebooks.com (DRM status not confirmed); distributor sells print only |

Removing DRM is prohibited in the EU even for owned copies (InfoSoc Directive Art. 6), and the private-copy exception does not cover copies made from unlawful sources (CJEU C-435/12, *ACI Adam*, 2014). So "buy the ebook and ingest it" does not work, and pirated copies are out.

**Decision:**

- **Allowed sources, in order of priority:**
  1. **Open corpus first.** This includes open-access papers (Seiler 2010 IJSPP, Stöggl & Sperlich 2014, Gabbett 2016 BJSM, Impellizzeri et al. 2020, Bosquet et al. 2007, Plews et al. 2013) and public articles from Uphill Athlete, TrainingPeaks, Joe Friel, Matt Fitzgerald and Scientific Triathlon, for personal use only. Phase 4 is built and validated on this corpus alone.
  2. **Print copies scanned by the athlete** (private copy of a lawfully owned book; no DRM involved). Planned for *Triathlete's Training Bible* and *Daniels' Running Formula* once the pipeline is proven, and optionally *Uphill Athlete*.
  3. **Publisher-permitted export**, i.e. the VitalSource print feature within its per-book limit, for selected chapters.
  4. **Kindle highlights (read.amazon.com/notebook) and the athlete's own chapter notes.** This applies to *Your First Triathlon*, which is a beginner book and low priority for this athlete.
  - **Never:** DRM-stripped files, shadow-library downloads, or bulk screenshotting of protected ebooks.
- **Two layers, not just RAG.** Books improve plans mainly through the always-in-context principles block (ADR-004), because `plan_generation` doesn't retrieve by default. Each ingested book gets an offline distillation pass: Claude summarizes each chapter into rules, numbers and applicability conditions, and those notes are hand-merged into `STATIC_SYSTEM_PROMPT`. Chunks go to RAG for specifics. `search_literature` is exposed to `plan_generation` as well as `knowledge_qa`.
- **Source files never enter git.** `data/literature/` is git-ignored; the only copy in the system is `literature_chunks` in Neon.
- **Ingestion is a CLI script** (`npm run ingest -- <file>`), never runtime:
  - extract → normalize to Markdown (EPUB/HTML via parser, text PDFs via `pdftotext`, scans via OCR + a cleanup pass for hyphenation, running headers and page numbers)
  - heading-aware chunks of ~500–800 tokens with ~10% overlap, each prefixed with `Source — Chapter — Section` before embedding
  - embed in batches and log to `api_usage` with `call_type: 'embedding'`
  - upsert keyed on `(source, content_hash)` so re-runs are idempotent (ADR-009 style)
- **Schema change from spec.md §4.1** — `literature_chunks` gains `section`, `locator` (page or location, for citations), `source_type` (`paper` | `article` | `book_scan` | `notes`), `content_hash`, unique `(source, content_hash)`. The embedding is stored as `real[]`; pgvector isn't needed while search stays in memory.
- **Retrieval eval.** A fixture of 15–20 questions with the expected source; top-5 recall is checked whenever chunking changes.
- **Open question, decide before Phase 4 starts:** the embedding provider. The candidates are OpenAI `text-embedding-3-small` (spec default, adds a second vendor) and Voyage AI (Anthropic's recommended embeddings partner). Cost is negligible either way at this corpus size.

---

## ADR-015: Health data comes from Intervals.icu, not Terra

**Problem:** spec.md §7.3 routes Garmin and Apple Health data through Terra's API because Garmin doesn't write HRV to Apple Health. Terra's free tier is gone (checked 2026-09-24): the Unified API is billed per active authentication and per event on top of a paid subscription, which the €20/month cap can't carry. Garmin's own Health API is free but only for approved business partners, and the unofficial Garmin Connect login libraries (`garminconnect`, `garth`) break Garmin's terms and break whenever Garmin changes its login flow.

**Decision:**
- **Read wellness data from Intervals.icu.** It is an official Garmin partner: with "Download wellness data" enabled under Settings → Connections → Garmin, it receives the athlete's Garmin wellness data. Its free REST API takes a personal API key (HTTP basic auth, user `API_KEY`). `GET /api/v1/athlete/{id}/wellness?oldest=&newest=` returns one record per local date.
- **Mapping** (`src/integrations/intervals/mapper.ts`): `sleepSecs` → `sleep_duration_minutes`, `sleepScore` → `sleep_quality_score`, `hrv` → `hrv_ms`, `restingHR` → `resting_hr`, `stress` → `stress_avg`, `weight` → `weight_kg`, `bodyFat` → `body_fat_pct`. No sleep stages: `deep_sleep_minutes` and `rem_sleep_minutes` stay empty. There's no standard Body Battery field; if the Garmin sync adds one as a custom field (any numeric key named like `BodyBattery`), it's picked up, and `raw_data.intervals` keeps the whole record to check against.
- **Polling, not webhooks.** A `node-cron` job (`intervals-wellness`, `15 6-22 * * *`, `Europe/Ljubljana`, plus once on boot) re-reads the last 3 local days and upserts by date (ADR-009). Re-reading covers a watch that syncs late and a sleep score revised in the morning. That's about 17 requests a day. With no inbound endpoint, nothing needs webhook authentication.
- **Failure alerts** (stack doc §5): the scheduler wraps every job; the first failure of a streak sends one Telegram message and a later success sends one "works again". An expired key produces one alert, not seventeen a day.
- **Env:** `INTERVALS_API_KEY` (secret, scrubbed from logs), `INTERVALS_ATHLETE_ID` (e.g. `i12345`). Either unset → the job isn't scheduled. The `TERRA_*` variables are removed.
- **Body composition** (Xiaomi scale → Mi Fitness → Apple Health) doesn't reach Intervals.icu unless the weight also lands in Garmin Connect. It's a weekly trend, so it waits: the athlete can tell the bot, or a later iOS Shortcut can post it. Health Auto Export (~€3/month) is the fallback if that proves too manual.
- **Bonus for later:** the same records carry Intervals.icu's `ctl` / `atl` / `rampRate` (fitness, fatigue, ramp rate), useful for the ACWR rules in the system prompt. Not stored yet.

**Revisit if:** Intervals.icu's Garmin sync turns out to miss HRV for this watch (HRV Status needs an Elevate Gen 3+ sensor), or its API terms change.

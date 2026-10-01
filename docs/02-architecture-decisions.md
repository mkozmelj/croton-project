# Architecture Decisions

ADR-style log of the project's design decisions. Each entry: the problem, the decision, and why.

> **Note on references.** The ADRs were written against three planning documents that were removed on 2026-10-01 once the build was finished: `spec.md` (the original design), the pre-implementation review ("review doc #N") and the build plan. References to them are kept as written; the files are in git history (`git log --diff-filter=D -- spec.md`). Where an ADR and the original spec disagreed, the ADR was what got built.

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
- Current pricing (per MTok, for budget calculations; checked 2026-09-26): Sonnet 5 — $2.00 in / $10.00 out (its launch price became the standard price; the planned rise to $3/$15 on 2026-09-01 was cancelled). Haiku 4.5 — $1.00 in / $5.00 out. Re-derive spec.md §8.4's cost estimates against these figures once ADR-005's thinking policy is applied — thinking tokens count as output tokens and will push per-interaction cost above the spec's original estimates for Sonnet-tier calls.
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
- **Phase 3 decision (2026-09-24): Google Calendar → REST as well**, without the authenticated MCP spike, because the choice doesn't depend on whether MCP works:
  - Calendar writes happen **after the athlete taps Confirm** (ADR-007), in code, from the stored plan. With MCP, the booking would be a model turn with `mcp_toolset`, and the confirm gate would be a prompt instruction instead of code. It would also cost a Claude call per booking.
  - REST gives idempotent retries: events are created with a deterministic id (`croton` + a sha256 of the booking and session), and a 409 becomes a `PUT`, so a retried confirmation never duplicates events. An MCP tool call can't guarantee that.
  - MCP adds its tool definitions to every call's cached prefix, while REST is ~120 lines (`src/integrations/google/{oauth,calendar,plan-events}.ts`) with no beta header.
  - Reading the athlete's own events for planning is one REST `GET` (`calendar-context.ts`), rendered into the plan-generation prompt as data.
  - Scope: `calendar.events` only (events on the primary calendar, no settings or sharing). OAuth uses `access_type=offline` + `prompt=consent` so every grant returns a refresh token, stored per ADR-011.
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

**Update (Phase 3, 2026-09-24):** chat calls now carry the tool definitions, and tools render before `system`, so they're part of the cached prefix. A measured Sonnet call shows a **7.7K-token cached prefix** (tools ≈ 4.8K, mostly the week-plan schema, plus the static prompt ≈ 2.9K), with a cache write on call 1 and a full read on call 2. A cached read costs ~€0.002 per call, but a cold 1h write now costs ~€0.042 instead of €0.012, which is about +€0.9/month at 30 cold writes. Plan generation uses structured output instead of tools, so it has its own (smaller) cache entry. The new monthly estimate is ~€4.5, still well under the cap.

**Update (2026-09-26): Sonnet 5 stays at $2/$10** (the planned rise to $3/$15 was cancelled), so every Sonnet line below costs about two thirds of what's shown. That's €1.84 in, €9.20 out, €3.68 for a 1h cache write and €0.18 for a cache read per MTok. The Phase 3 estimate of ~€4.5 a month drops to **~€3.0**.

Typical month: 60 chats €1.44 + 4 recaps €0.52 + 8 adjustments €0.46 + 8 analyses €0.62 + 20 summaries €0.08 + 30 cold writes €0.37 ≈ **€3.50** (spec.md's €1.14 was ~3× low, mostly thinking tokens and all-Sonnet chat). If thinking runs at double the assumption: ~€6. Both are well under the €14 cap, so thinking stays on; `DISABLE_THINKING` is the lever if real numbers drift toward the 75% alert. Once the Phase 5 router moves most chat to Haiku, the chat line drops to ~€0.4/month.

**Implementation notes (Phase 5, 2026-09-27): the router.** `src/agent/classifier.ts` routes every free-text message with keyword rules, biased per review doc #13:
- Any day word (weekdays, today, tomorrow, weekend), plan/week/schedule/session/workout word, sport or workout type, race word, or threshold word (FTP, VDOT, zones, pace) forces Sonnet. With an edit verb (move, swap, skip, add, can't make, travelling …) it's `plan_adjustment`; otherwise `chat`, which stays as the "training topic, not clearly an edit" type (Sonnet, low).
- The athlete's own trends or load (volume, HRV, fatigue, on track, improving … plus I/my) is `analysis`.
- Haiku gets only greetings, thanks and acknowledgements (`quick_chat`), and general questions with no personal words and no forcing keyword (`knowledge_qa`, with `search_literature` available).
- A message within 15 minutes of a Sonnet reply stays on Sonnet (`chat`) unless it's pure thanks, because "yes, do it" may need the tools. Onboarding always runs on Sonnet. Anything else that's uncertain goes to Sonnet.
- **Escalation:** if a Haiku-routed call still tries `propose_week_plan`, the attempt is dropped and the round is redone as `plan_adjustment`, so a week plan is never written by Haiku.
- `/deep <message>` is a new `deep` call type (Sonnet, medium). The monthly memory job has its own `conversation_summary` type (Haiku). Both are in `CALL_POLICIES`, so `llm_usage.call_type` tells them apart.
- Haiku chat calls carry the same tools, so their prefix (~7.7K tokens) is above Haiku's cache minimum and gets its own 1h cache entry.

Expect less of the chat traffic to move to Haiku than the estimate above assumed: most coaching messages mention a day, a session or a sport. Check the split in `llm_usage` after a few weeks.

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

**Implementation notes (Phase 3):**
- **Action types.** Confirmations: `set_goal`, `update_profile`, `add_fitness_marker`, `apply_plan` (a week's plan, saved and booked in one step; used for the Sunday plan and mid-week changes, so no separate `book_calendar`). Conversation modes: `recap` (the next message is the week's feedback) and `onboarding` (the chat context gets the onboarding checklist). Payloads are zod-validated when written and again when confirmed (`src/agent/actions.ts`).
- **Confirmation is a button, not a parsed "yes".** Each proposal is sent as its own message, rendered by code from the payload (so the athlete confirms what will be written, not the model's paraphrase), with Confirm/Cancel inline buttons (`callback_data` `pa:<id>:ok|no`). The bot therefore also receives `callback_query` updates, which the ADR-006 chat check covers.
- **Exactly once.** Confirm consumes the row with `DELETE … RETURNING`, so a double tap runs once. If execution fails (e.g. an expired Google token), the row is restored with the same id and the buttons stay, so Confirm works again once the cause is fixed.
- **Expiry:** 24 h for confirmations and `recap`, 7 days for `onboarding`. A newer plan proposal replaces the older one.
- The model only proposes: chat tools (`src/agent/tools.ts`) create rows, and nothing writes without a tap.

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
- **Implementation notes (Phase 5): refresh failures.** Both OAuth clients refresh through `createTokenRefresher` (`src/integrations/token-refresh.ts`). A transient failure (network error, timeout, 5xx, 429) is retried after 1 s and 4 s, so 3 attempts in total, then thrown as `TokenRefreshError`. A rejected grant (400/401: access revoked, refresh token expired, wrong client secret) isn't retried. When a refresh finally fails, the athlete gets one Telegram message per failure streak: "rejected" asks for `/reauth strava` or `/reauth calendar`, "unavailable" says it'll retry next time. The streak ends with the next successful refresh. Errors that already alerted are marked, so the background-task boundary doesn't send a second message for the same activity. `/reauth` is the same single-use-`state` flow as `/connect`. The streak lives in memory, so a restart can repeat the alert once.

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
- **Every event is confirmed with the API (2026-10-01).** `subscription_id` and `owner_id` aren't secrets (the athlete id is in the public profile URL), so they only filter noise. A delete is applied only when `GET /activities/{id}` returns 404, a deauthorization only when `GET /athlete` is rejected (401 or a rejected refresh), and a fetched activity is stored only when its `athlete.id` equals the event's `owner_id`. Before this, a forged event could delete stored activities, drop the Strava tokens, or import another athlete's visible activity.
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
- ~~The GitHub repo stays **private**.~~ **Update (2026-10-01): the repo is public** (MIT). Before publishing, the full history was scanned for keys, tokens, connection strings, chat and athlete IDs, GPS data and health values, and the commit author email was rewritten. The rules above matter more now: anything committed is published.

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
  - embed in batches and log to `llm_usage` with `call_type: 'embedding'`
  - upsert keyed on `(source, content_hash)` so re-runs are idempotent (ADR-009 style)
- **Schema change from spec.md §4.1** — `literature_chunks` gains `section`, `locator` (page or location, for citations), `source_type` (`paper` | `article` | `book_scan` | `notes`), `content_hash`, unique `(source, content_hash)`. The embedding is stored as `real[]`; pgvector isn't needed while search stays in memory.
- **Retrieval eval.** A fixture of 15–20 questions with the expected source; top-5 recall is checked whenever chunking changes.
- **Embedding provider (decided 2026-09-26): OpenAI `text-embedding-3-small`, 1536 dimensions.** Voyage AI was the alternative: a free token allowance and separate document/query embeddings, but slow on its free tier without a card. The athlete chose OpenAI. The corpus is under 1M tokens, so the cost is about $0.01 per full ingest at $0.02 per MTok. The real cost is OpenAI's prepaid minimum (~$5 a year), with auto-recharge off. `OPENAI_API_KEY` is set in `.env` and Railway. It stays optional in `src/config/env.ts` so the app boots without it, and `search_literature` reports "not configured" in that case.
- **Each row records its `embedding_model`.** Vectors from different models can't be compared, so search only loads rows that match the current model. Changing models means re-running ingest on the source files.
- **Open-access check (2026-09-26).** A Europe PMC lookup showed that only part of the "open corpus" above is open access. Stöggl & Sperlich 2014 (Frontiers) and Gabbett 2016 (BJSM, PMC4789704) are, and both are ingested. Impellizzeri et al. 2020 (J Athl Train, Parts 1 and 2) is free to read on PMC but not in the open-access subset, so its full text has to be saved by hand. Seiler 2010 (IJSPP), Bosquet et al. 2007 (MSSE) and Plews et al. 2013 (Sports Med) have no open full text. For those, the options are the athlete's own notes (`--type notes`) or a lawfully obtained copy.
- **Open papers come as JATS XML** from `https://www.ebi.ac.uk/europepmc/webservices/rest/<PMCID>/fullTextXML`. It has cleaner sections than a two-column PDF, but no page numbers, so citations name the section instead. PDF extraction drops table "number soup" and headings glued to the text.
- **Web articles (2026-09-26).** Ingested from TrainingPeaks (ATL/CTL/TSB, thresholds, two taper articles, efficiency factor and decoupling), Joe Friel (setting zones, hard-easy training), 80/20 Endurance (triathlon intensity guidelines, the moderate-intensity rut, the ventilatory threshold) and Scientific Triathlon (nutrition quick guide, sprint/Olympic training guide). Uphill Athlete's HTML pages return 403 to scripted downloads. Its robots.txt allows crawling with a 5 s delay, though, and its public WordPress REST API serves the same articles, so the 7 articles (aerobic deficiency, the heart rate drift test, the 10% test, zones, muscular endurance, downhill technique, trail training) came through the API at that pace. The HTML bot protection itself isn't worked around (no headless browser). HTML extraction reads the largest content container and skips promo sections (newsletter, related articles, share, trials).
- **Citations are text, not API citation blocks.** Anthropic's `search_result` content blocks with citations can't be combined with structured output (`output_config.format`), which plan generation uses. So `search_literature` returns labelled passages (`source | chapter | section | page`) and the system prompt asks for a brief (source, page) citation. `plan_generation` gets the tool through a search-only loop (at most two rounds, then `tool_choice: none`); its tool turns are not stored in `conversations`.

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
  **Resolved (2026-09-24):** an iOS Shortcut now writes weight and body fat to Intervals.icu's standard `weight` and `bodyFat` wellness fields, so the existing sync stores them with no code change. The context shows them as 8 weeks of weekly averages plus the change over 4 weeks, and W/kg next to FTP (newest weight at most 30 days old). `/profile` shows the same.
- **Load metrics:** the same records carry Intervals.icu's `ctl` / `atl` / `rampRate` (fitness, fatigue, ramp rate). Stored from Phase 3 on, see ADR-016.

**Revisit if:** Intervals.icu's Garmin sync turns out to miss HRV for this watch (HRV Status needs an Elevate Gen 3+ sensor), or its API terms change.

---

## ADR-016: Fitness baseline — how the agent knows the athlete's current level

**Problem:** Plan quality depends on knowing how fit the athlete is right now, and nothing designed how the agent finds out. `athlete_profile` has `vdot`, `ftp`, `css` and `sport_zones` columns, and [context.ts](../src/agent/context.ts) injects them, but:
- The only way to fill them was the chat onboarding and `/profile`, both in Phase 5. Weekly plan generation arrives in Phase 3, so the first plans would be built on an empty profile with generic zones.
- No source is defined for any value: nothing is imported, no field tests are specified, and nothing derives VDOT from a race.
- There's no load baseline beyond the last two weeks of activities. That isn't enough to apply the 10% rule, set a starting volume or use the ACWR rule. ADR-015 left Intervals.icu's `ctl`/`atl`/`rampRate` "not stored yet".
- A single value per column has no date or source, so an 8-month-old FTP would drive every workout without anyone noticing.
- Nothing captures training background (years per sport, typical weekly hours, recent race results, available hours), which a coach uses to set starting volume.

**Decision:**

- **Threshold values become a dated history.** A new `fitness_markers` table replaces `athlete_profile.vdot`/`ftp`/`css` (the migration copies any existing values in with `source: 'athlete_reported'`, then drops the columns):
  ```
  fitness_markers
  ├── id: serial PK
  ├── sport: text           # 'run' | 'bike' | 'swim' | 'all' (max/resting HR when not sport-specific)
  ├── metric: text          # 'ftp_w' | 'lthr_bpm' | 'max_hr_bpm' | 'threshold_pace_s_per_km' | 'css_s_per_100m' | 'vdot'
  ├── value: numeric
  ├── measured_on: date     # when the value was established, not when the row was written
  ├── source: text          # 'intervals' | 'field_test' | 'race' | 'athlete_reported'
  ├── source_ref: text?     # activity external_id or events.id for field_test / race
  ├── notes: text?
  ├── created_at: timestamp
  unique (sport, metric, measured_on, source)   -- upsert target (ADR-009)
  ```
  The current value is the latest row per `(sport, metric)`. Older rows stay, so the agent can say "FTP up 12 W since May".
- **Zones are derived, not maintained by hand.** `athlete_profile.sport_zones` stays as the applied snapshot. It's rewritten whenever a threshold marker changes: Intervals.icu's zones are used as-is when that sport has them, and otherwise they're computed in code (Coggan % of FTP, Friel % of LTHR, Daniels paces from VDOT, CSS offsets). Claude never does the arithmetic. VDOT from a race result also uses the Daniels–Gilbert formula in code (`src/training/`), with tests against published table values.
- **Source 1: an Intervals.icu import.** `GET /api/v1/athlete/{id}` returns `sportSettings[]`, one per group of activity `types`, with `ftp`, `lthr`, `max_hr`, `threshold_pace` and `hr_zones`/`power_zones`/`pace_zones`. The athlete record has `icu_resting_hr` and `weight`. It runs as a weekly `node-cron` job (`intervals-profile`, Sundays 18:30 `Europe/Ljubljana`, before the recap; plus once on boot and before every plan generation; originally daily, see the implementation notes) with the same failure-streak alerting as ADR-015. It writes a new marker row only when a value differs from the latest `intervals` row, with `measured_on` = today. It reuses `INTERVALS_API_KEY`/`INTERVALS_ATHLETE_ID`. Before writing the mapper, check the units and zone encoding (for example whether `threshold_pace` is m/s, and whether zones are absolute or % of threshold) against a real response and record them in a fixture.
- **Source 2: a chat onboarding.** It runs once, triggered from `/start` when `athlete_profile.background` is empty, or with `/onboard`. A short Sonnet conversation collects:
  - years training per sport and typical weekly hours
  - recent race results (last ~18 months), which become `race` markers with computed VDOT
  - weekly availability, which goes into `preferences`
  - injuries, which go into `injury_notes`
  - any threshold Intervals.icu didn't supply
  
  Writes go through `pending_actions` (`update_profile`, `add_fitness_marker`) with a confirm step, the same rule as goals (ADR-010). `background` is a new `jsonb` column on `athlete_profile`, validated with zod: `{ years_by_sport, typical_weekly_hours, recent_results[], notes }`.
- **Source 3: field tests.** Protocols go into `STATIC_SYSTEM_PROMPT`. They're static, so they're cached:
  - bike: 20-min test, FTP = 95% of average power, with LTHR from the same effort
  - run: Friel 30-min solo test, LTHR = average HR of the last 20 min, threshold pace = average pace
  - swim: CSS from 400 m + 200 m time trials
  
  When a planned test activity arrives, the activity-summary flow proposes the resulting marker for confirmation.
- **Load baseline is stored.**
  - `health_metrics` gains `ctl`, `atl` and `ramp_rate`, mapped from the wellness records ADR-015 already fetches.
  - The context builder takes a `weeks` option. Chat keeps this week + last week. `plan_generation` gets 6 weeks of per-sport totals (time, distance, D+), plus the CTL/ATL/ramp-rate trend over the same window and ACWR from the latest record.
  - CTL is only as complete as the activities Intervals.icu has, so the athlete enables Garmin activity sync in Intervals.icu as well as wellness. After the first import, check that CTL is plausible against the activity history.
- **Missing or stale values are flagged, not hidden.**
  - `profileLines` prints each marker with its age and source ("FTP 245 W, from Intervals.icu, 3 weeks ago").
  - A marker is **stale** after 12 weeks, or after 8 weeks in the build/peak phases. Stale markers get a "stale" flag in the context.
  - For each sport with activity in the last 6 weeks, the agent needs at least one intensity anchor: bike `ftp_w` or `lthr_bpm`; run `vdot`, `threshold_pace_s_per_km` or `lthr_bpm`; swim `css_s_per_100m`. A sport without one gets a context line telling the agent to prescribe by RPE and schedule a field test.
  - Plan generation does **not** refuse to run. An RPE-based week with a test in it beats no plan. It does say at the top of the recap what's missing or stale.

**Why a separate table instead of dated columns:** thresholds change several times a season, and the trend matters for coaching feedback and race prediction (spec.md §15). One row per measurement also gives each value its date and source without doubling every column.

**Phasing:** the import, the onboarding, the load baseline and the context flags are the first part of Phase 3, before weekly plan generation. The breakthrough check (an activity clearly beating a threshold, such as a 20-min power above 105% of FTP, suggests an update) comes later.

**Implementation notes (Phase 3):**
- **Checked against a real `GET /athlete/{id}` (2026-09-24), recorded in `src/integrations/intervals/test-fixtures.ts` with fake values:** `threshold_pace` is **m/s** whatever `pace_units` says. `power_zones` are **% of FTP** upper bounds, with the last one `999` (open-ended). `hr_zones` are **absolute bpm** upper bounds, with the last one equal to max HR. There's one `sportSettings` entry per group of `types`, plus an "Other" group, which is ignored. `pace_zones` were null for every sport, so their encoding is unverified: run and swim pace zones are always computed in code, and Intervals.icu's zones are used for HR and power only.
- Marker mapping: bike `ftp` → `ftp_w`; `lthr` → `lthr_bpm` per sport; run `threshold_pace` → `threshold_pace_s_per_km` (1000 / m/s); swim `threshold_pace` → `css_s_per_100m` (100 / m/s); `max_hr` → one `all` marker when it's the same for every sport, otherwise one per sport.
- Zones (`src/training/zones.ts`): an Intervals.icu zone set is used while its basis (the LTHR or FTP it was built on) equals the current marker. A newer field test or report computes zones in code instead: Coggan power, Friel HR (separate run and bike tables), run pace from the newer of VDOT (Daniels) and threshold pace (Friel %), swim CSS offsets. Each set records its method and basis.
- VDOT uses the Daniels–Gilbert equations and matches the published table within 0.3 at 5K–marathon for VDOT 40, 50 and 60 (tests). Training paces use VDOT fractions fitted to the VDOT 50 row.
- Migrations: `0002` adds the tables and columns, and `0003` copies `vdot`/`ftp`/`css` into `fitness_markers` (`athlete_reported`, dated from the profile's `updated_at`) before dropping them. There are two files because drizzle-kit asks interactively when one migration both adds and drops columns on the same table.
- Field-test detection works from laps, so the protocols in the static prompt say where to press lap. A 20-min lap gives FTP (95%) and LTHR for the bike. The last 20 min of the run test gives LTHR and threshold pace. The 400 m and 200 m laps give CSS. No matching lap means no proposal, and the athlete can report the values in chat.
- Plan week rule: `/recap` from Friday to Sunday plans next week; from Monday to Thursday it re-plans the rest of this week.
- **Threshold check is weekly (changed after Phase 3):** a daily import was cheap but pointless, since thresholds only matter when a plan is made. `intervals-profile` runs on Sundays at 18:30 (before the 19:00 recap) and on boot, and plan generation refreshes thresholds first (best effort; a failure is logged and the stored values are used). A marker's `measured_on` is the day it was read, so it can be up to 6 days late, which doesn't matter against the 12-week stale limit.
- **History import (`/import`):** the Strava webhook only stores new activities, so the database starts empty and the 6-week baseline has nothing in it. `/import` pulls the last 12 months from Strava's activity list (summary records without laps; a year is one or two requests) and 90 days of wellness. Activities go through `insertMissing` (`ON CONFLICT DO NOTHING`) so a detailed webhook record is never replaced by a summary, and no notifications are sent. Running it again only fills gaps. Plan generation then also gets per-sport totals by month over 12 months and, per sport, the biggest week and longest session. Chat keeps the 6-week window. Strava is the source rather than Intervals.icu, whose API only returns activities from its own integrations (34 Garmin activities back to July for this athlete; Strava has the full history).

**Implementation notes (Phase 5): breakthrough check** (`src/training/breakthroughs.ts`, run with the field-test check by `src/agent/marker-proposals.ts` for every new Strava activity):
- **Bike:** the best effort of at least 20 minutes (a lap, or the whole ride) by plain average power. The weighted average is left out because it overstates what the athlete can sustain. It needs measured power (`device_watts`). The estimate is 95% of that power.
- **Run** (outdoor road runs only: trail pace says little about flat-ground fitness, and treadmill distance (Strava `trainer`) is unreliable): VDOT from the fastest effort between 1500 m and the marathon (a lap or the whole run). Threshold pace comes from the fastest effort of at least 20 minutes, the Friel test rule.
- **Margin:** a proposal needs the estimate to beat the current marker by at least 3%. For FTP that means an effort above about 108% of FTP. The build plan's "> 105%" example is exactly what a correctly set FTP predicts for an all-out 20 minutes, so it would propose after every hard ride. VDOT jumps over 10 points and paces more than 30% faster are treated as GPS glitches or mis-tagged activities.
- A planned field test on that day takes precedence (no second proposal for the same effort).
- Proposals go through `pending_actions` like every other marker, with the new source `activity` ("from a hard workout"). `source` is a plain `text` column, so this needed no migration.

**`/profile` editing (Phase 5):** `/profile ftp 250`, `lthr run 168`, `maxhr 190`, `pace 4:15`, `css 1:45`, `vdot 48.5` or `vdot 10k 45:30` (computed in code), `availability …`, `injuries …`, `name …`, with an optional trailing date. Each edit becomes the same `add_fitness_marker` or `update_profile` proposal the chat tools create, with range checks against typos. Zones still can't be edited: they follow the markers.

---

## ADR-017: Telegram messages are HTML

**Problem:** every message went out as plain text, and the system prompt told the model not to use Markdown. The longer messages (`/profile`, the weekly plan, recaps) were hard to read as one wall of text.

**Decision:**
- **Every `sendMessage` and `editMessageText` uses `parse_mode: "HTML"`.** A grammy API transformer (`src/bot/parse-mode.ts`, installed in `configureBot`) sets it, so replies and notifier messages get it without each call site passing it. If Telegram still rejects the markup ("can't parse entities"), the transformer sends the same message again as plain text with the tags stripped. A formatting bug costs the formatting, never the message.
- **HTML, not MarkdownV2.** MarkdownV2 rejects the whole message when any of 18 characters is unescaped, and training text is full of them (`4:15 /km`, `(80% easy)`, `3x8 min.`). HTML only reserves `<`, `>` and `&`.
- **Text built in code** uses the helpers in `src/bot/html.ts` (`esc`, `bold`, `quote`, `section`, sport and intensity emoji). All data (DB values, athlete input, model-written plan titles and notes) goes through `esc()`. Long detail that's rarely read (zones, workout structure in the week view) goes in expandable quotes.
- **Text written by the model** (chat replies, the recap, the activity comment) is light Markdown, as the prompt now allows. `src/bot/markdown.ts` converts it to HTML when it's sent. Stored conversations keep the Markdown, so replayed history is what the model wrote. Asking the model for HTML directly was rejected: an unescaped "HR <150" would break the message.
- **The plain renderings stay** for the model: `describeProposal`, `planLines`/`planText`, `describeActivity` and friends feed the prompt context and stored turns. The Telegram versions live in `src/bot/` (`formatting.ts`, `plan-html.ts`, `proposal-html.ts`).
- **Activity notifications** show the numbers in a header rendered by code. The model writes only the comment underneath. Over budget, the header is sent alone.
- `splitMessage` works on the HTML. A tag still open at a cut is closed at the end of that chunk and reopened at the start of the next, and a cut never lands inside a tag or an entity.

---

## ADR-018: Post-activity feedback lives in its own table

**Problem:** The activity summary tells the athlete what the data says, but the agent never learns how a session felt. Session RPE, how the legs felt, pain or niggles and why a workout went off plan are the inputs a coach uses most, and none of them come from Strava or Intervals.icu. The answers have to be stored with the activity and used in planning, and asking must not become a chore the athlete learns to ignore.

**Decision:**
- **A separate table, not columns on `activities`.** `activities` is upserted by every Strava `update` event and every re-import (ADR-009), so feedback there would be one careless `set` clause away from being overwritten. One row per activity:
  ```
  activity_feedback
  ├── id: serial PK
  ├── activity_id: integer UNIQUE → activities.id ON DELETE CASCADE
  ├── rpe: integer null          # 1–10 session RPE
  ├── feel: text null            # 'awful' | 'meh' | 'good' | 'strong'
  ├── pain: boolean null         # null = not asked / not answered
  ├── pain_note: text null
  ├── note: text null
  ├── rpe_source: text null      # 'athlete' | 'strava' (RPE read from the activity)
  ├── created_at, updated_at
  ```
  Every write is an upsert on `activity_id`, so a double tap or a changed answer just updates the row.
- **Buttons first, typing optional.** The questions go in their own message after the summary, as inline buttons: RPE (1–10, two rows), feel (4 buttons), pain (No / Yes), and an "Add a note" button. `callback_data` is `fb:<activityId>:<field>:<value>`, well under Telegram's 64 bytes, so each answer names its activity and two activities in a row can't get mixed up. A tap writes directly: no Claude call, no `pending_actions` row. The message is edited to show the answers so far.
- **Free text only when the athlete asks for it.** "Pain: Yes" and "Add a note" start a new `activity_feedback` conversation mode in `pending_actions` (payload `{ activityId, field: 'painNote' | 'note' }`, 1 h expiry, ADR-007). The next message is stored as-is and acknowledged, then the mode ends. The bot never takes over the next message on its own, so an ordinary chat message after a summary isn't swallowed as feedback. Notes are stored as raw text, with no extraction call: the model reads them in context.
- **Not every activity gets the full set.** The full set is sent when the activity matches a planned non-easy workout in `training_plans`, lasts 90 minutes or more, or is a detected field test or breakthrough. Anything else gets only the RPE rows and the note button. Imports (`/import`, `tp:import`) and activities older than 24 hours at arrival get no questions at all. These rules are a first guess; revisit them after a few weeks of use.
- **Don't ask for what's already known.** If the Strava activity already has a perceived exertion (the `perceived_exertion` field in `raw_data`, when present), it's stored with `rpe_source = 'strava'` and the RPE rows are left out.
- **Feedback is used, not just collected.**
  - Dynamic context (after the cache breakpoint, ADR-004): one short line per activity with feedback in the chat window, e.g. `Tue run 62 min: RPE 7, meh, note "legs heavy from Monday"`.
  - Pain is flagged: any pain note in the last 14 days appears in its own context line, and two or more reports in 14 days add a line telling the planner to reduce load on that area and ask about it.
  - Session RPE load (RPE × minutes) per week sits next to training load in plan generation and the Sunday recap. When RPE rises at similar HR or pace, that's a fatigue signal the planner should name.

**Why not a Claude-driven conversation?** A model asking follow-up questions reads nicer but costs a Sonnet call per activity, is harder to keep short, and gives answers that have to be parsed back into fields. Buttons give clean numbers for free, and the free-text note still catches everything the buttons can't.

**Implementation notes (Phase 6):**
- Code: `src/db/activity-feedback.ts` (store), `src/agent/feedback-questions.ts` (question rules, Strava RPE), `src/agent/feedback-format.ts` (context lines, session-RPE load), `src/bot/feedback.ts` (message, buttons, tap handler). Migration `0006`.
- **Note mode expires after 1 hour, not 24.** The mode takes over the next message, and a chat message sent the next day shouldn't become a note because a button was tapped and forgotten. A newer tap replaces an open note; "No pain" after "Some pain" closes the pain note. The note mode comes before an open recap, since it was started more recently.
- **Redrawing after a tap:** the questions asked are read back from the tapped message's own buttons, so nothing about the question set is stored. Selected answers get a ✓, and tapping another answer changes it (the row is upserted field by field).
- **A tap on a deleted activity** gets "That activity is gone" and the buttons are removed. The store checks that the activity exists before the upsert, so the foreign key never throws.
- **Strava RPE is only read when the activity is first synced.** An RPE added in the Strava app later (an `update` event) isn't picked up; the bot's own question covers that case. `perceived_exertion` isn't in Strava's published API reference, so it's parsed defensively and still has to be confirmed against a real activity.
- Session RPE load appears per week in chat context (this and last week) and per baseline week in plan generation. The recap prompt mentions session feedback under recovery.

---

## ADR-019: A matched Strava activity takes the planned session's title and description

**Problem:** A Strava activity says "Morning Run" even when it was the planned tempo session, and nothing on Strava shows what the session was meant to be.

**Decision:**
- **One matcher** (`src/training/plan-match.ts`) decides which planned workout an activity fulfilled, for both the feedback questions (ADR-018) and Strava: same local day, a fitting sport (a run can fulfil a trail run or a brick), a duration between 40% and 250% of the plan (bricks exempt), and not already taken by another activity. Among several, the exact sport wins, then the closer start time.
- **The match is recorded on the workout** as `strava_activity_id` in `training_plans.plan`, next to `calendar_event_id`. A second run that day can't take the same session. A plan change from today on replaces today's workouts and drops their links; days before today keep theirs.
- **Only on `create`**, after all the Telegram messages. `PUT /activities/{id}` sets `name` to the planned title and appends a plain-text block to the description (`src/integrations/strava/plan-description.ts`): planned title, duration and intensity, the structure, targets, field test, minutes done vs planned, session number in the week and the phase. The athlete's or device's own text stays first. A rerun replaces the block, which starts with `📋 Planned:` and runs to the end.
- **Plan and compliance only, never wellness data or the coach's comment.** Strava descriptions are usually public, and the workout `notes` and the Telegram comment can mention HRV, sleep or weight.
- **`activity:write` is requested but optional.** Connections from before this change don't have it until `/reauth strava`. Without it the match is still recorded and Strava is left alone. The granted scope is read from `oauth_tokens.scope`.
- Our own edit makes Strava send an `update` event. The sync re-fetches and upserts the activity (its `notes` now include the block). No notification is sent, because only `create` notifies.
- A failed update (`StravaApiError`, `StravaAuthError`) goes through the background-task runner like any other Strava failure: a log line and the usual Telegram alert.

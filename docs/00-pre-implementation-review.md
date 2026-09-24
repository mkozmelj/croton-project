# Pre-Implementation Review

A critical read of `spec.md`, done before writing any code. Each item below is either a **correction** (something in the spec is now wrong or will break), a **gap** (something the spec assumes but doesn't design), or a **risk to de-risk early** (cheap to check now, expensive to discover mid-build).

Full reasoning and the resulting decisions live in `02-architecture-decisions.md`. This doc is the "why we need that ADR" list.

---

## Corrections (spec.md is factually stale)

### 1. Model IDs and pricing are outdated
`spec.md` references "Sonnet 4.6" and "Haiku 4.5" with 2025-era pricing. As of today (2026-09-23):

| Model | ID | Input / Output per MTok | Context | Notes |
|---|---|---|---|---|
| Claude Sonnet 5 | `claude-sonnet-5` | $3.00 / $15.00 | 1M | Current Sonnet-tier model. Its intro discount window ($2/$10) ended 2026-08-31 — full price applies now. |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1.00 / $5.00 | 200K | Unchanged from spec. No adaptive thinking or `effort` support. |

**Behavioral change that affects cost, not just the ID:** on Sonnet 4.6 (what the spec assumed), omitting the `thinking` parameter meant *no thinking*. On Sonnet 5, omitting it runs **adaptive thinking by default** — every Sonnet-tier call now spends thinking tokens unless you explicitly pass `thinking: {type: "disabled"}`. This directly affects the budget model in spec.md §8.4, which was costed assuming thinking-off. See ADR-005.

### 2. The MCP `mcp_servers` code snippet in spec.md §7.1/§7.2 is incomplete
Passing `mcp_servers: [{type: "url", url, name, authorization_token}]` is real and does work for third-party remote MCP servers with OAuth bearer tokens — but it requires **two things spec.md's snippet omits**:
- The beta header `mcp-client-2025-11-20` on the request.
- A paired `tools: [{type: "mcp_toolset", mcp_server_name: "<same name>"}]` entry. Without it, the request is rejected as a validation error — declaring a server without a toolset entry referencing it does nothing.

This is a code-level fix, not a design change — but it would have caused a confusing 400 on first attempt. Fixed in ADR-002.

### 3. `spec.md`'s Sunday cron time ("19:00 CET") is a label bug waiting to happen
Slovenia observes CEST (UTC+2) roughly March–October. A cron job scheduled by the literal string "CET" will drift an hour off from what the athlete expects half the year. Use `node-cron`'s IANA timezone option (`Europe/Ljubljana`) and stop naming a fixed offset anywhere in code or copy.

---

## Gaps (spec.md doesn't design for these, but needs to)

### 4. Conversation storage can't round-trip tool calls
`conversations.content: text` (spec.md §4.1) stores plain strings. But Claude's multi-turn API requires replaying the *exact* content-block structure — `tool_use` blocks in assistant turns, paired `tool_result` blocks in the following user turn, and (if extended thinking is ever surfaced) `thinking` blocks passed back unmodified. A single `text` column loses all of that structure. Any assistant turn that called a tool becomes unreplayable, which will surface as a hard-to-diagnose bug the first time an activity-summary or plan-adjustment conversation gets more than one turn deep. Fixed in ADR-003 (store the full content-block array as `jsonb`).

### 5. The Sunday recap confirmation step needs to survive a restart
Section 6.4's flow ends with "Agent asks for confirmation... on confirmation, creates Google Calendar events." Between "asked" and "confirmed" there's pending state — which plan is awaiting booking. Railway restarts on deploys and crash-recovery; if that state lives only in a JS variable, a restart mid-confirmation silently loses the pending plan and the athlete's "yes" does nothing. This needs a durable, tiny state machine. See ADR-007.

### 6. No access control on the Telegram webhook
The spec never states that the bot only responds to one Telegram user. `TELEGRAM_WEBHOOK_SECRET` (spec.md §9.3) authenticates that a webhook payload came from Telegram — it does **not** restrict who can message the bot. Anyone who finds the bot's username on Telegram can chat with it and burn LLM budget. This is a five-line fix (allowlist one `chat_id` from env) but needs to be a stated requirement, not an afterthought. See ADR-006.

### 7. No prompt-caching design, despite a stable ~3–4K token system prompt
Spec.md §5 describes a system prompt with a large static block (training principles, ~3,000 tokens) and a dynamic block (athlete profile, current week, today's health metrics) interpolated *before* it in the same prompt. Prompt caching is a strict prefix match — if the dynamic block comes first, the static block behind it never gets a stable prefix to cache against, and caching silently does nothing. This is pure upside once fixed (repeated static content billed at ~10% of normal input cost) and pure waste if left as-is. See ADR-004.

### 8. No decision on `thinking`/`effort` per call type
Now that Sonnet 5 defaults to adaptive thinking on, every model-router tier (`plan_generation`, `plan_adjustment`, `analysis`, `quick_chat`, etc.) needs an explicit thinking/effort policy, not just a model choice. Left undecided, actual spend will drift from the estimates in spec.md §8.4. See ADR-005 — **this is also a question for you** (see below).

### 9. No linting/formatting/type-strictness baseline
Spec.md names TypeScript + Vitest but says nothing about lint/format tooling or `tsconfig` strictness. For "clean and maintainable long-term" with a single maintainer and heavy Claude Code involvement, this needs to be decided once and enforced from commit #1, not retrofitted. See `01-stack-and-principles.md`.

### 10. No local dev workflow
Telegram webhooks need a public HTTPS URL; Strava/Google OAuth callbacks do too. Spec.md's setup checklist assumes Railway is already deployed before any of these are testable, which is fine for first deploy but leaves no fast local iteration loop for later work. Addressed in `03-build-plan.md` Phase 1 (grammy supports long-polling for local dev — no tunnel needed for the Telegram side at least).

### 11. No observability/error-alerting mechanism beyond "log everything"
Spec.md §14 says "log everything for debugging" but doesn't say where logs go or how failures get noticed. On a €20/month budget, a paid error tracker (Sentry etc.) isn't in scope — the design needs to lean on Railway's built-in log retention plus the Telegram-alert-on-failure pattern already planned for Phase 5, made concrete. See `01-stack-and-principles.md` → Observability.

---

## Risks worth de-risking before Phase 2 (not Phase 1)

### 12. Do the Strava and Google Calendar MCP servers in spec.md actually exist at those URLs?
`https://mcp.strava.com/mcp` and `https://calendarmcp.googleapis.com/mcp/v1` are stated in spec.md §2.2 without a citation, and this review did not independently verify either endpoint. Spec.md already flags this as Risk R-01 with a REST fallback — the only change here is sequencing: **verify both URLs (or their absence) at the start of Phase 2, before writing any MCP integration code**, rather than treating REST as a fallback to reach for only after MCP fails in practice. If neither server exists publicly, go straight to REST and delete the MCP code path entirely rather than maintaining two integration layers for one working path.

### 13. Model router misclassification risk is asymmetric
A quick-chat message misrouted to Sonnet costs a few cents. A weekly-plan-generation request misrouted to Haiku produces a *worse training plan* the athlete may actually follow — the failure mode is silent and consequential, not just wasteful. Bias the classifier: default to Sonnet whenever the message mentions a day of the week, a workout type, "plan," "week," or a race, and reserve Haiku for the clearly-safe categories (greetings, `/tomorrow`, activity-summary webhooks). The `/deep` override in spec.md §6.1 is a good safety valve but shouldn't be the primary defense.

---

## Open questions (need your call)

See the questions raised via AskUserQuestion at the end of this session — summarized here for the record:

1. **Thinking/effort policy vs. budget** — leaving adaptive thinking on for Sonnet-tier calls (recap, plan generation, plan adjustment, analysis) improves plan quality but adds token spend on every one of those calls versus explicitly disabling it. Given the hard €20/month cap, which default do you want?
2. **Proceed to Phase 1 now, or pause here** — these docs answer "what do we need to decide before implementing"; the next step is either scaffolding the repo (Phase 1 of `03-build-plan.md`) or you reviewing this material first.

---

## Added during Phase 0 review (2026-09-24)

### OAuth tokens can't be env vars
spec.md §9.3 stores Strava/Google access + refresh tokens as env vars. Strava can rotate the refresh token on every refresh and the app can't write to Railway's variables, so the integration would break after the first rotation. See ADR-011.

### Webhook authentication is wrong or missing in the spec
Strava webhooks aren't signed (spec.md §6.5 assumes they are), Terra verification uses the signing secret rather than the dev ID (§7.4), and the Telegram webhook secret isn't wired to anything. See ADR-012.

### No written rule for keeping secrets out of the repo
Log redaction was covered; commit hygiene wasn't. See ADR-013 and `01-stack-and-principles.md` §9.


---

## Added during Phase 2 review (2026-09-24)

### No design for how the agent learns the athlete's current fitness
`athlete_profile` has columns for VDOT, FTP, CSS and zones, but nothing says where the values come from, and the onboarding that would fill them was scheduled after plan generation. There's also no load baseline beyond two weeks, and no dates on the values to show when they go stale. See ADR-016.

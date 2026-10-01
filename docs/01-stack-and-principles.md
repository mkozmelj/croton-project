# Stack & Engineering Principles

The stack is chosen for this project's scale: single user, low traffic, tight budget. This document pins exact choices and states the conventions that keep the codebase "effective but clean" as Claude Code sessions add to it over time — the audience for the *conventions* section is as much future-Claude as it is Martin.

## 1. Stack (final)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict mode, ESM (`"type": "module"`) | Type safety catches schema/API-shape drift before runtime; ESM avoids CJS/ESM interop friction with modern packages. |
| Runtime | Node.js 24 LTS (pinned in `.nvmrc` + `package.json` `engines`), `tsx` for dev | Native TS execution in dev, compiled output in prod. 24 over 22: 22 is maintenance-only and reaches EOL April 2027; 24 is Active LTS until April 2028. |
| Framework | Fastify | Fast, schema-validating, plugin-based — good fit for a handful of webhook routes plus a health check. |
| Database | Neon Postgres (free tier) | Serverless, room to add `pgvector` later if the in-memory RAG approach outgrows itself. Free-tier compute scales to zero after ~5 min idle; the first query after that adds a few hundred ms — irrelevant for a chat bot, but don't read it as "always warm". |
| ORM | Drizzle | Schema-as-code, generates typed queries, migrations are plain SQL you can read and commit. |
| LLM | Claude API — `claude-sonnet-5-5` + `claude-haiku-4-5` | See `02-architecture-decisions.md` ADR-001 for exact IDs and the pinning strategy. |
| Chat | Telegram Bot API via `grammy` | Free, typed, supports both webhook (prod) and long-polling (local dev) transport with no code change. |
| Scheduler | `node-cron`, explicit IANA timezone | In-process, zero extra infra, avoids the DST bug of a fixed "19:00 CET" label. |
| Hosting | Railway, hobby plan | Always-on, GitHub auto-deploy, portable (just Docker + env vars) if a migration is ever needed. |
| Lint/format | **Biome** | Single dependency, single config file, formats and lints in one fast pass. Chosen over ESLint+Prettier specifically because this is a solo-maintained project where tool-config maintenance should cost near-zero — two overlapping tools (ESLint's formatting rules vs Prettier) is exactly the kind of accidental complexity to avoid here. |
| Validation | `zod` | Runtime validation for env vars, webhook payloads, and Claude tool inputs — one library covers all three, and Zod schemas double as the source for Claude tool `input_schema` where needed. |
| Logging | `pino` | Structured JSON logs, cheap, plays well with Railway's log viewer. No paid log aggregator — Railway's own retention is the log store. |
| Testing | Vitest | Fast, native TS/ESM support, same mental model as Jest. |

## 2. TypeScript conventions

- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `verbatimModuleSyntax: true`. These aren't negotiable defaults to loosen later — they catch the exact class of bug (undefined DB rows, silently-optional API fields) that's expensive to debug in a webhook handler at 7am on a Sunday.
- No `any`. If a boundary is genuinely untyped (raw webhook JSON, raw Claude tool input before validation), type it `unknown` and narrow with a `zod` schema immediately — don't let `unknown`/`any` leak past the parsing boundary.
- Prefer `type` over `interface` for data shapes; reserve `interface` for anything meant to be extended (rare in this codebase).
- No barrel files (`index.ts` that just re-exports everything) unless a directory genuinely needs one public surface — they make it harder to trace where a symbol actually lives, and this repo is small enough that direct imports are cheap to write.

## 3. Project structure conventions

Follow the existing layout (see [the architecture guide](guide/05-architecture.md#directory-layout)), with one rule: every directory under `src/integrations/*` and `src/agent/` that does non-trivial parsing or business logic gets a co-located `*.test.ts` file — not a mirrored `test/` tree. Co-location keeps the test next to the code it's testing, which matters more here than a "conventional" separate test tree, because Claude Code sessions editing one file should see its test in the same directory listing.

- **One module, one responsibility.** `tool-handlers.ts` executes tools; it does not also format Telegram messages. `formatting.ts` formats messages; it does not query the DB. If a file starts doing two things, split it — this is cheap now and expensive after month three of accretion.
- **No default exports.** Named exports only. Default exports make renames and re-exports fragile and don't show up cleanly in "find references."
- **Config lives in one place.** `src/config/env.ts` is the only file under `src/` that reads `process.env` directly (tooling config like `drizzle.config.ts` at the repo root is the one exception), and it validates everything through a single `zod` schema at startup — fail fast on a missing/malformed env var rather than discovering it mid-request. Every other module imports the typed config object.

## 4. Database & Drizzle conventions

- Every table gets `created_at`. Add `updated_at` with an `on update` trigger wherever a row is mutated after creation (`athlete_profile`, `training_plans`), so "when did this last change" is always answerable without git-archaeology.
- Migrations are generated (`drizzle-kit generate`), never hand-written from scratch, and always committed alongside the schema change in the same commit. Never edit a migration file that's already been applied to any environment — write a new one.
- Prefer `jsonb` with a `zod` schema validating the shape in application code over adding new columns for every nested field — but don't reach for `jsonb` as a way to avoid modeling relationships properly (e.g. `activities` and `health_metrics` stay first-class tables, not JSON blobs inside `training_plans`).

## 5. Error handling & observability

- **Fail loud, fail typed.** Custom error classes per failure domain (`StravaAuthError`, `BudgetExceededError`, `TelegramSendError`) rather than throwing raw strings or generic `Error`. Catch at the boundary (webhook handler, cron job) and decide there — don't swallow errors deep in a utility function.
- **Structured logs, not `console.log`.** Every log line goes through the shared `pino` logger with a `module` field, so `grep`-ing Railway logs for `module":"budget"` actually works.
- **User-facing failure = Telegram message, not silence.** Any uncaught error in a webhook handler or cron job sends a short Telegram message to the athlete ("Something broke processing your Strava activity — logged, will look into it") in addition to the structured log. This is the entire observability budget for a €20/month single-user app, and it's enough: the one person who needs to know already has the channel open. The boundaries are the grammy error middleware (Telegram updates), the Fastify 5xx error handler (HTTP routes), the background-task runner (Strava events), `guardedJob` (cron, one alert per failure streak), and, as the last resort, `unhandledRejection`/`uncaughtException` handlers in `src/utils/process-guards.ts`. `/selftest` fails on purpose to check them.
- No secrets in logs, ever — `pino`'s redaction config should explicitly redact `access_token`, `refresh_token`, API keys, and the `authorization` / `x-telegram-bot-api-secret-token` headers at the logger level, not rely on every call site remembering to omit them. Configure it in Phase 1, not Phase 5.

## 6. Claude API usage conventions

- **Pin exact model ID strings in `src/config/env.ts` as constants**, not scattered string literals — one place to bump when a model is retired. See ADR-001 for the current IDs.
- **Every Claude call goes through one wrapper** (`src/agent/claude.ts`) that handles: budget check before the call, token/cost logging after, and the system-prompt caching structure (ADR-004). No call site constructs a raw `client.messages.create(...)` directly.
- **Tool definitions live in one file** (`src/agent/tools.ts`) as the single source of truth; `tool-handlers.ts` implements them. Keep tool `description` fields prescriptive about *when* to call the tool, not just what it does — current-generation models under-trigger tools without an explicit "call this when..." nudge.
- **Structured outputs over prompt-engineered JSON.** Where the agent needs a machine-parseable result (e.g. classification, plan structure), use `output_config.format` with a JSON schema rather than asking the model to "respond only with JSON" and hoping — this avoids an entire class of parsing bugs.

## 7. Testing strategy

| What | How | Where |
|---|---|---|
| Pure functions (cost calculation, message classification heuristics, Strava/Intervals.icu payload parsing) | Vitest, no mocks needed | Co-located `*.test.ts` |
| DB queries | Vitest against a real (throwaway) Neon branch or local Postgres via `testcontainers` — not mocked Drizzle | `src/db/*.test.ts` |
| Webhook handlers | Vitest with a constructed Fastify instance + `.inject()`, mocked Claude client | `src/integrations/*/webhook.test.ts` |
| Full agent flow | Manual, via the real Telegram bot in a test chat — not automated (single-user tool) | N/A |

Run `biome check` and `vitest run` in CI (a single GitHub Actions workflow, or as a Railway pre-deploy check if that's simpler) — the goal isn't heavyweight CI, it's "don't deploy something that doesn't typecheck or pass its unit tests."

## 8. Automation principles (for "I want to fully automate the whole process")

- **Everything reproducible from `git clone` + `.env` + `npm install` + `npm run migrate`.** No manual DB setup steps beyond what Drizzle migrations do.
- **Migrations run on boot** (`drizzle-kit migrate` in `index.ts` before the server starts listening), so a fresh Railway deploy is always schema-correct without a manual step.
- **Webhook registration is code, not a console click**, wherever the provider's API allows it (Telegram: `setWebhook` call in `bot/setup.ts` on boot; Strava: subscription creation script in `integrations/strava/`). Manual-only steps (OAuth authorization the *first* time, account creation) stay manual because they genuinely can't be automated — everything downstream of "I have a token" should be.
- **One command runs the whole test+lint+build gate locally**: a single `npm run check` script (`biome check && vitest run && tsc --noEmit`) that mirrors exactly what CI runs, so there's never a "works on my machine, fails in CI" surprise.

## 9. Security & secrets

The full reasoning is in `02-architecture-decisions.md` ADR-011–013; the working rules:

- **Secrets live in `.env` locally (git-ignored) and in Railway variables in prod — nowhere else.** Not in docs, tests, fixtures, commit messages or logs. `.env.example` has every var with an empty value.
- **Check before every commit** that nothing secret is staged: no `.env`, no tokens, no connection strings with passwords, no real chat IDs or personal health values. If a secret ever lands in git, rotate it at the provider first.
- **OAuth tokens are data, not config:** stored encrypted in `oauth_tokens`, refreshed and re-saved by the app (ADR-011). OAuth flows always use a single-use `state`.
- **Every webhook is authenticated before parsing** (Telegram secret header, Strava verify token + subscription/owner check), with timing-safe comparison and a tested reject path (ADR-012).
- **Validate everything that crosses a boundary with `zod`** — webhook bodies, OAuth callback params, Claude tool inputs. Treat text coming back from Strava/Calendar/Intervals.icu and literature chunks as data, not instructions, when it's placed into a prompt.
- **Keep the GitHub repo private** and dependencies current (`npm audit` on dependency bumps; dev-only advisories in tooling like `drizzle-kit` are acceptable when they can't reach production).

# 4. Customizing

Croton was written for one athlete: a multi-sport amateur in Slovenia who trains for triathlon, road and trail running, rides and swims, and plays tennis. Most of it is general, but some parts carry that athlete's assumptions. This page lists what to change to make the coach yours, roughly in order of importance.

## The coaching prompt (change this first)

**File:** [`src/agent/system-prompt.ts`](../../src/agent/system-prompt.ts)

This is the coach's brain: role, training principles (periodization, 80/20 intensity, Daniels running paces, triathlon and trail specifics, recovery and load rules), field-test protocols, multi-sport scheduling rules, and behavior rules. It's about 100 lines of plain English. Read all of it.

Typical edits:

- **Your sports.** The role line lists running, trail running, triathlon, cycling, swimming, tennis and strength. Remove what you don't do, and add what you do (rowing, skimo, climbing). The tennis rules, such as "competitive tennis counts as a hard day", are a good template for any non-periodized sport you play.
- **Your philosophy.** If you or your coach prefer pyramidal over polarized distribution, different taper lengths, or a different weekly increase limit, change it here.
- **Language.** Replace `Respond in English.` with your language. Note that the bot's own texts (command replies, buttons, plan views in `src/bot/formatting.ts`, `plan-html.ts`, `feedback.ts`) are English strings in code and would need translating separately.
- **Units.** The prompt asks for metric units.

**Rule: this text must be static.** It sits in front of the prompt-cache breakpoint ([ADR-004](../02-architecture-decisions.md#adr-004-system-prompt-caching--split-static-from-dynamic)). Never put dates, names, or anything that changes into it. Anything about *you* goes into the dynamic context built by [`src/agent/context.ts`](../../src/agent/context.ts), which already includes your profile, markers, goals, plan, recent activities, wellness, feedback and memory notes. `npm test` includes checks that the static prompt stays deterministic.

## Sports and activity types

If you add a sport that the coach should plan, several places need to know about it:

| File | What it holds |
|---|---|
| [`src/training/plan.ts`](../../src/training/plan.ts) | The list of sports a planned workout can have (the plan schema the model fills in) |
| [`src/integrations/strava/mapper.ts`](../../src/integrations/strava/mapper.ts) | Strava `sport_type` to Croton sport |
| [`src/integrations/trainingpeaks/mapper.ts`](../../src/integrations/trainingpeaks/mapper.ts) | The same for TrainingPeaks imports |
| [`src/bot/html.ts`](../../src/bot/html.ts) | The emoji per sport in Telegram |
| [`src/integrations/google/plan-events.ts`](../../src/integrations/google/plan-events.ts) | The emoji per sport in calendar event titles |
| [`src/agent/classifier.ts`](../../src/agent/classifier.ts) | Sport words that route a message to Sonnet |
| [`src/training/plan-match.ts`](../../src/training/plan-match.ts) | Which activity sport can fulfil which planned sport (a run can fulfil a trail run) |

Run `npm run check` afterwards. The tests will point out anything you missed in the typed lists.

## Time zone and schedule

- **`TIMEZONE`** (env, IANA name such as `America/Denver`) drives "today", week boundaries, calendar event times, and every cron job. Never use an offset label like "CET": it drifts by an hour for half the year.
- **Cron jobs** are defined in [`src/index.ts`](../../src/index.ts) and run in `TIMEZONE`:

  | Job | Default | Purpose |
  |---|---|---|
  | `sunday-recap` | `0 19 * * 0` (Sun 19:00) | Asks for the weekly recap |
  | `intervals-profile` | `30 18 * * 0` (Sun 18:30) + boot | Imports thresholds before the recap |
  | `intervals-wellness` | `15 6-22 * * *` + boot | Wellness sync, hourly while you're awake |
  | `conversation-memory` | `30 3 1 * *` | Monthly summarization of old messages |

  Want the recap on Monday morning? Change both the recap and the profile import, so thresholds are fresh before the recap.

## Budget and models

- **`MONTHLY_LLM_BUDGET_EUR`** (env) sets the monthly cap. The thresholds (75 %, 90 %, ~96 %, 100 %) are in [`src/agent/budget.ts`](../../src/agent/budget.ts).
- **`DISABLE_THINKING=true`** (env) turns off extended thinking on every Sonnet call. It's the quickest way to cut cost if spend runs high.
- **Model IDs** live in one place, `MODELS` in [`src/config/env.ts`](../../src/config/env.ts). **Prices** are in [`src/config/pricing.ts`](../../src/config/pricing.ts), with a fixed USD to EUR rate. When you change a model, update both. Cost tracking is only as good as that table.
- **Thinking and effort per call type** (chat, plan generation, analysis, and so on) are in `CALL_POLICIES` in [`src/agent/claude.ts`](../../src/agent/claude.ts). Every Claude call goes through this one wrapper. Keep it that way, or the budget stops being enforced.
- **Routing rules** (which messages go to Haiku) are in [`src/agent/classifier.ts`](../../src/agent/classifier.ts). They're biased towards Sonnet on purpose: a wrong cheap answer about your plan costs more than the few cents saved.

## Integrations you don't use

Every integration except Telegram, Claude and the database is optional:

- **No Strava:** no activity sync, summaries, feedback questions or `/import`. You can still plan, chat, and set goals.
- **No Google Calendar:** confirmed plans are saved and shown with `/plan` and `/tomorrow`, just not booked.
- **No Intervals.icu:** no HRV, sleep or weight data, and no threshold import. Enter thresholds with `/profile`, and the coach plans without recovery data.
- **No OpenAI:** no literature search. The core principles in the system prompt still apply.

Leave the variables unset and the feature is off. If you want a different source, for example Garmin directly, Whoop or Oura, the integration layer is built to be swapped: look at how [`src/integrations/intervals/`](../../src/integrations/intervals/) maps external records into `health_metrics` and `fitness_markers`, and write the same for your provider. Use upserts only, never plain inserts (ADR-009).

### Not renaming Strava activities

When `activity:write` is granted, a matched activity is renamed and gets the plan in its description ([ADR-019](../02-architecture-decisions.md#adr-019-a-matched-strava-activity-takes-the-planned-sessions-title-and-description)). If you don't want that, untick the write permission when connecting Strava. Everything else keeps working.

## Literature corpus

The coach answers most questions from the principles in the system prompt. For specifics it calls `search_literature`, which searches chunks you've ingested ([setup step 9](02-setup-and-deployment.md#9-optional-build-a-literature-corpus)).

**What to ingest, legally** ([ADR-014](../02-architecture-decisions.md#adr-014-literature-corpus--sourcing-and-ingestion) has the full reasoning):

- ✅ Open-access papers. Europe PMC serves clean JATS XML for many of them.
- ✅ Public articles, for personal use. Respect each site's `robots.txt` and rate limits.
- ✅ Your own notes and summaries (`--type notes`).
- ✅ Scans of print books you own, for your private copy (`--type book_scan`), depending on your country's private-copy rules.
- ❌ DRM-stripped e-books, or anything from shadow libraries. Removing DRM is illegal in the EU even for books you bought.

Source files go in `data/literature/`, which git ignores. **Never commit them to your fork**, especially if it's public: they'd be redistributed. The chunks only live in your database.

[`src/knowledge/eval-fixtures/`](../../src/knowledge/eval-fixtures/) holds a small fixture corpus of hand-written summaries, plus a retrieval test (recall@5) that runs in `npm test`. If you change chunking, run `npm run eval:embed` to refresh the cached vectors and check that recall holds.

## Importing old training plans

If you trained with a TrainingPeaks plan before, export the workouts as CSV and import them:

```sh
npm run tp:import -- data/trainingpeaks/workouts.csv --from 2024-01-01 --to 2024-12-31 --dry-run
npm run tp:import -- data/trainingpeaks/workouts.csv --from 2024-01-01 --to 2024-12-31 \
  --plan-notes data/literature/my-2024-plan.md
npm run ingest -- data/literature/my-2024-plan.md --source "My 2024 plan" --type notes
```

Completed workouts become activities and are skipped where Strava already has them. The plan notes become searchable, so the coach can refer to "what worked last season".

## Pages served by the app

[`src/pages.ts`](../../src/pages.ts) serves `/` and `/privacy`, which Google requires before an OAuth app can be published. They describe a single-operator app. Adjust the wording to your situation, especially if you're in a jurisdiction with specific privacy-notice rules.

## Conventions to keep when changing code

The codebase follows a few rules that keep it safe and cheap. They're listed in full in [`CLAUDE.md`](../../CLAUDE.md) and [`docs/01-stack-and-principles.md`](../01-stack-and-principles.md). The important ones:

- All Claude calls go through `src/agent/claude.ts`.
- The model proposes, and code writes only after a button tap.
- External data is `unknown` until a zod schema narrows it. No `any`.
- Every webhook or sync write is an upsert.
- Every Telegram message is HTML. Escape data with `esc()`.
- Failures produce a log line *and* a Telegram message.
- `npm run check` passes before every commit.

---

**Next:** [Architecture](05-architecture.md)

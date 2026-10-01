# Croton: a personal AI training coach on Telegram

Croton is a self-hosted training coach for one amateur endurance athlete. You talk to it in a Telegram chat. It reads your Strava activities and your Garmin recovery data, knows your thresholds and season goals, writes a structured training plan every week, and puts the sessions in your Google Calendar once you confirm them.

It was built for a single multi-sport athlete (triathlon, running, trail running, cycling, swimming, tennis) and runs in the cloud for well under €20 a month. That includes hosting, and the AI spend has a hard cap.

The code is meant to be forked. Every athlete is different, so the [customization guide](docs/guide/04-customizing.md) shows which parts to change to make the coach yours.

> **Not medical advice.** Croton is a hobby project. It is not a doctor, physiotherapist or certified coach. If something hurts, see a professional.

---

## What it does

| | |
|---|---|
| **Weekly recap and plan** | Every Sunday at 19:00 the bot asks how your week went. You answer in plain language. It compares planned and actual training, looks at recovery trends (HRV, resting HR, sleep, load), and proposes next week's plan with warm-up, main set, cool-down and your own pace, power and heart-rate targets. |
| **Calendar booking** | Tap **Confirm** and the sessions land in Google Calendar, placed around the events already there. Nothing is written without a tap. |
| **Mid-week changes** | "I have a tennis match Thursday, move my tempo run." The coach reshuffles the week and asks you to confirm again. |
| **Activity summaries** | When you finish a workout, Strava notifies the bot. You get the numbers and a short coach comment, plus one-tap questions (RPE, how it felt, any pain). The answers are used in the next plan. |
| **Planned title on Strava** | If an activity matches a planned session, it is renamed on Strava ("Morning Run" becomes "Tempo 3×8 min"), and the plan goes in the description. |
| **Fitness baseline** | It imports FTP, LTHR, threshold pace, max HR and zones from Intervals.icu, works out VDOT from race results, and suggests a new threshold when a workout clearly beats the current one. It flags values that are old or missing and schedules field tests. |
| **Season goals** | Your A, B and C races, with the training phase (base, build, peak, taper) worked out from the date of your A race. |
| **Training knowledge** | It answers questions from a built-in set of sports-science principles. It can also search a literature corpus you build yourself (papers, articles, your own notes) and cites the source. |
| **Budget guard** | Every AI call is costed and logged. You get alerts at 75 % and 90 % of the monthly cap, then it switches to a cheaper model, then it stops. |

## How it works

![Architecture diagram: the Telegram chat talks over a webhook to the Node.js app on Railway, where the bot and router pass messages to the agent orchestrator and the Claude wrapper, which calls the Anthropic API. The orchestrator makes tool calls to OpenAI embeddings (optional), Neon Postgres, Google Calendar and the Strava REST API. Strava sends activity events to the Strava webhook, and the scheduler polls Intervals.icu, which syncs wellness data from Garmin Connect.](docs/images/how-it-works.webp)

- **One process, one database.** A Fastify server takes the Telegram and Strava webhooks and serves the OAuth callbacks. Scheduled jobs run inside the same process. All state lives in Postgres, so a restart loses nothing.
- **The model proposes, code writes.** The model never writes to the database or the calendar directly. It creates a *proposal*, the bot shows it with Confirm and Cancel buttons, and code applies it after the tap.
- **Code does the maths.** Zones, VDOT, plan matching and threshold detection are tested TypeScript. The model gets the results as context.
- **Two models, one wrapper.** Claude Sonnet handles planning and analysis; Claude Haiku handles small talk and summaries. Every call goes through one wrapper, which checks the budget, logs cost, and keeps the static part of the system prompt cached.

For a tour of the code, see [Architecture](docs/guide/05-architecture.md).

## Services and costs

| Service | Used for | Required? | Typical cost |
|---|---|---|---|
| [Telegram](https://core.telegram.org/bots) | The chat interface | Yes | Free |
| [Anthropic Claude API](https://console.anthropic.com) | The coach itself | Yes | ~€3–6 / month at normal use, hard-capped (default €14) |
| [Neon](https://neon.tech) | Postgres database | Yes | Free tier is plenty |
| [Railway](https://railway.com) | Hosting (always-on Node.js, HTTPS) | Yes, or any host with a public HTTPS URL | ~$5 / month (Hobby) |
| [Strava API](https://developers.strava.com) | Activities, webhooks, renaming activities | Optional, but most features need it | Free |
| [Google Calendar API](https://developers.google.com/calendar) | Booking planned sessions | Optional | Free |
| [Intervals.icu](https://intervals.icu) | Garmin wellness (HRV, sleep, resting HR, weight) and thresholds | Optional | Free (donations welcome) |
| [OpenAI API](https://platform.openai.com) | Embeddings for literature search | Optional | Cents per ingest, but OpenAI requires a ~$5 prepaid minimum |

The app starts with only the required services. Each optional integration turns on when its environment variables are set, and the bot tells you what isn't connected. Prices change, so check them before relying on these numbers.

## Get your own coach running

You'll need about two hours, most of it creating accounts and clicking through developer consoles. In short:

1. **Create the accounts and keys.** See [Accounts and services](docs/guide/01-accounts-and-services.md).
2. **Fork the repo** and run it locally against a *separate dev bot*.
3. **Deploy to Railway**, set the environment variables, and find your Telegram chat ID.
4. **Connect Strava and Google Calendar** from the chat (`/connect`) and register the Strava webhook.
5. **Load your history** (`/import`) and **tell the coach about yourself** (`/onboard`).
6. **Set a goal** ("My A race is a half marathon on 14 March, I want to go under 1:45") and run `/recap`.

The full walkthrough is in [Setup and deployment](docs/guide/02-setup-and-deployment.md). Before you rely on it, read [Customizing](docs/guide/04-customizing.md): the coaching prompt is written for one specific athlete's sports, and you will want to change it.

## Documentation

**Guides (start here)**

1. [Accounts and services](docs/guide/01-accounts-and-services.md): every external service, what it's for, and how to get its credentials.
2. [Setup and deployment](docs/guide/02-setup-and-deployment.md): local development, Railway, connecting integrations, and the full list of environment variables.
3. [Using the bot](docs/guide/03-using-the-bot.md): commands, the weekly cycle, confirmations, and budget levels.
4. [Customizing](docs/guide/04-customizing.md): making the coach fit your sports, language, schedule, budget and literature.
5. [Architecture](docs/guide/05-architecture.md): code layout, request flows, data model, and conventions.
6. [Security](SECURITY.md): the threat model, how each entry point is authenticated, known limitations, and the operator checklist.

**Design records**

- [`docs/02-architecture-decisions.md`](docs/02-architecture-decisions.md): 19 ADRs (why REST instead of MCP, why Intervals.icu instead of Terra, how prompt caching is structured, how the literature corpus is sourced legally, and more).
- [`docs/01-stack-and-principles.md`](docs/01-stack-and-principles.md): the stack and coding conventions.
- [`ROADMAP.md`](ROADMAP.md): open work and ideas.

## Tech stack

TypeScript (strict, ESM) on Node.js 24 · Fastify · grammY · Drizzle ORM + Neon Postgres · Anthropic TypeScript SDK · node-cron · zod · pino · Biome · Vitest. There are about 470 tests: `npm run check` runs lint, type-check and the full suite.

## Project status

Built in six phases, and in daily use by its author:

- **In production:** chat, budget, Strava sync and summaries, Intervals.icu wellness and thresholds, goals, onboarding, weekly planning, Google Calendar, literature search, model routing, conversation memory, token-refresh alerts, post-activity feedback questions, and plan-matched Strava titles.
- **Open:** see [`ROADMAP.md`](ROADMAP.md).
- **Not planned:** multi-user support. The app is single-athlete by design: one authorized chat, one Strava account, one calendar. If you want to coach several people, run one deployment per athlete.

## License

[MIT](LICENSE) © 2026 Martin Kozmelj. You may use, change and share it; please keep the copyright notice.

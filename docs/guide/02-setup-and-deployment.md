# 2. Setup and deployment

This guide takes you from a fork to a working coach in your Telegram. It assumes you've collected the credentials from [Accounts and services](01-accounts-and-services.md), or that you'll collect them as each step needs them.

**Overview**

1. [Run it locally](#1-run-it-locally) with a dev bot
2. [Deploy to Railway](#2-deploy-to-railway)
3. [Find and set your chat ID](#3-find-and-set-your-chat-id)
4. [Connect Strava](#4-connect-strava)
5. [Connect Google Calendar](#5-connect-google-calendar)
6. [Register the Strava webhook](#6-register-the-strava-webhook)
7. [Turn on Intervals.icu](#7-turn-on-intervalsicu)
8. [Load history and onboard](#8-load-history-and-onboard)
9. [Optional: build a literature corpus](#9-optional-build-a-literature-corpus)

At the end: the [environment variable reference](#environment-variable-reference), [updating](#updating), and [troubleshooting](#troubleshooting).

---

## 1. Run it locally

You need **Node.js 24** (the repo has an `.nvmrc`) and git.

```sh
git clone https://github.com/<you>/croton-project.git
cd croton-project
nvm use              # or install Node 24 another way
npm install
cp .env.example .env
```

Fill in `.env` with at least the required values:

```ini
NODE_ENV=development
TELEGRAM_BOT_TOKEN=<your DEV bot token>
TELEGRAM_AUTHORIZED_CHAT_ID=<your chat id, or 0 for now>
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://...
```

Use a separate Neon **branch** or database for development, so experiments don't touch your real data. Neon creates a branch in one click.

```sh
npm run dev      # tsx watch: restarts on file changes
npm run check    # Biome lint + tsc --noEmit + Vitest, must pass before every commit
```

In development the bot uses **long polling**, so you don't need a public URL. Message your dev bot and it answers. OAuth callbacks go to `http://localhost:3000/...`, which Strava always accepts and Google accepts once you've added that redirect URI. Strava webhooks can't reach your laptop, so use `/import` locally to pull activities.

> ⚠️ Never run `npm run dev` with the **production** bot token. When polling starts, grammY deletes the bot's webhook, and production stops receiving messages until its next deploy.

## 2. Deploy to Railway

1. Create a Railway project from your GitHub fork. [`railway.json`](../../railway.json) already sets the build command, start command and health check.
2. Generate a public domain under **Settings → Networking**.
3. Under **Variables**, add at least:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_URL` | `https://<your domain>` (no trailing path) |
   | `TELEGRAM_BOT_TOKEN` | your **production** bot token |
   | `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` |
   | `TELEGRAM_AUTHORIZED_CHAT_ID` | your chat ID, or `0` until step 3 |
   | `ANTHROPIC_API_KEY` | your key |
   | `DATABASE_URL` | your production Neon connection string |
   | `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` |
   | `TIMEZONE` | your IANA zone, e.g. `Europe/Berlin` (the default is `Europe/Ljubljana`) |

   Add the Strava, Google, Intervals.icu and OpenAI variables now or later. Each integration turns on when its variables are present.
4. Deploy. On boot the app runs the database migrations, starts the HTTP server, registers the Telegram webhook at `APP_URL/webhook/telegram` with your secret, and starts the scheduler.
5. Check that `https://<your domain>/health` returns `{"status":"ok"}`.

Every push to `main` redeploys, and every change to a variable restarts the service.

## 3. Find and set your chat ID

The bot only answers `TELEGRAM_AUTHORIZED_CHAT_ID` and silently drops everything else. It logs each dropped message, so:

1. With the variable at `0`, send any message to your production bot.
2. In Railway's **Deploy Logs**, find the `dropped unauthorized update` line. Its `chatId` field is your chat ID.
3. Set `TELEGRAM_AUTHORIZED_CHAT_ID` to that number. Railway restarts the app.
4. Send `/start`. The bot answers with a welcome message and the list of commands.

## 4. Connect Strava

Requires `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` to be set.

1. In Telegram, send `/connect strava`.
2. The bot replies with a link that is valid for 10 minutes and works once. Open it, approve access on Strava, and leave the activity boxes ticked.
3. The browser shows "Strava connected", and the bot confirms in the chat.

The tokens are stored encrypted in the `oauth_tokens` table and refreshed automatically. If access is ever revoked or a refresh is rejected, the bot tells you to send `/reauth strava`.

## 5. Connect Google Calendar

Requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY`, plus the Google Cloud setup from the [services guide](01-accounts-and-services.md#7-google-cloud-calendar-api), including publishing the consent screen.

1. Send `/connect calendar`.
2. Open the link and choose your Google account. Click through the "Google hasn't verified this app" warning (**Advanced → Go to …**). It's your own app.
3. Approve calendar access.

Booked sessions go to your primary calendar. Croton only changes events it created itself.

## 6. Register the Strava webhook

Strava pushes new activities to `APP_URL/webhook/strava`. A Strava API app can have only one webhook subscription, and you register it once from your machine:

1. Make sure **production** has `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` and `STRAVA_WEBHOOK_VERIFY_TOKEN`, and is deployed. The webhook route only exists when all four are set.
2. Make sure your **local** `.env` has the same `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` and `STRAVA_WEBHOOK_VERIFY_TOKEN` as production. The CLI also loads the rest of the app config, so the required variables must be set too.
3. Run:

   ```sh
   npm run strava:subscribe -- create https://<your domain>
   ```

   Strava calls your production app to verify the token, then prints the subscription, for example `{"id":123456}`.
4. Set `STRAVA_SUBSCRIPTION_ID` to that id in Railway. Until it's set, the app rejects every webhook event.
5. Record a short activity, or upload one, and you should get a summary in Telegram within seconds.

`npm run strava:subscribe -- list` shows the current subscription, and `-- delete <id>` removes it, for example if your domain changes.

## 7. Turn on Intervals.icu

Set `INTERVALS_API_KEY` and `INTERVALS_ATHLETE_ID` in Railway. After the restart, two jobs run:

- **`intervals-wellness`**: on boot, then hourly from 06:15 to 22:15. It re-reads the last 3 days of wellness data (sleep, HRV, resting HR, weight, CTL/ATL).
- **`intervals-profile`**: on boot, then Sundays at 18:30. It imports thresholds and zones and records a new fitness marker only when a value changed.

`/status` and `/profile` show what arrived.

## 8. Load history and onboard

1. **`/import`** pulls 12 months of Strava activities and 90 days of wellness. It sends no notifications and is safe to repeat. Plan generation uses this history for its baseline: recent volume, biggest weeks, longest sessions.
2. **`/onboard`** starts a short conversation about your background: years per sport, typical weekly hours, recent race results (VDOT is worked out from them), availability, and injuries. Each fact is shown with a Confirm button before it's saved.
3. **Set your goals in plain language**, for example: "My A race for 2027 is Ironman 70.3 Pula on 26 September, goal sub 4:45." Confirm the proposal. `/goals` lists your goals.
4. **`/recap`** produces your first weekly plan. From Friday to Sunday it plans next week; from Monday to Thursday it re-plans the rest of this week.

From then on the bot asks for your recap every Sunday at 19:00.

## 9. Optional: build a literature corpus

With `OPENAI_API_KEY` set, the coach can search sources you ingest and cite them. Ingestion runs locally and writes to the database that `DATABASE_URL` in your `.env` points to, so point it at production when you ingest for real.

```sh
npm run ingest -- data/literature/seiler-2010.pdf --source "Seiler 2010" --type paper
npm run ingest -- data/literature/my-notes.md --source "My coaching notes" --type notes
npm run ingest -- <file> --source "..." --type article --dry-run   # print chunks only
npm run ingest -- --list                                         # sources and chunk counts
```

Supported inputs are text PDFs, which need `pdftotext` from poppler (`brew install poppler`), OCR'd scans (`ocrmypdf` adds a text layer), EPUB, HTML, JATS XML from Europe PMC, and Markdown. Keep `--source` identical between runs of the same file, because it's part of the de-duplication key. The running app picks up new chunks on its next search.

Only ingest material you have the right to use. [Customizing](04-customizing.md#literature-corpus) explains what's fine and what isn't.

---

## Environment variable reference

Everything is validated at startup by `src/config/env.ts`. A missing or malformed required value stops the app with a clear error. An empty value (`KEY=`) counts as unset.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | | `development` | `production` uses the webhook, `development` uses long polling |
| `PORT` | | `3000` | Railway sets it |
| `LOG_LEVEL` | | `info` | pino level |
| `APP_URL` | in production | | Public base URL. Used for the Telegram webhook and OAuth redirects |
| `TIMEZONE` | | `Europe/Ljubljana` | IANA zone. Used for cron times, "today", and calendar events |
| `MONTHLY_LLM_BUDGET_EUR` | | `14` | Hard cap on Claude and OpenAI spend per calendar month |
| `TELEGRAM_BOT_TOKEN` | yes | | From BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | in production | | 16–256 chars of `A-Z a-z 0-9 _ -` |
| `TELEGRAM_AUTHORIZED_CHAT_ID` | yes | | The only chat the bot answers |
| `ANTHROPIC_API_KEY` | yes | | |
| `DISABLE_THINKING` | | `false` | `true` turns off extended thinking on Sonnet calls, to save money |
| `DATABASE_URL` | yes | | Neon, direct (non-pooler) host |
| `TOKEN_ENCRYPTION_KEY` | for Strava/Google | | 32 random bytes, base64 |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | for Strava | | From your Strava API app |
| `STRAVA_WEBHOOK_VERIFY_TOKEN` | for Strava webhooks | | Random string |
| `STRAVA_SUBSCRIPTION_ID` | for Strava webhooks | | Printed by `npm run strava:subscribe -- create` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Calendar | | Web-application OAuth client |
| `INTERVALS_API_KEY` / `INTERVALS_ATHLETE_ID` | for wellness and thresholds | | Intervals.icu → Settings → Developer Settings |
| `OPENAI_API_KEY` | for literature search | | Embeddings only |

## Updating

- **Your own changes:** run `npm run check`, then push to `main`. Railway builds and deploys, and migrations run on boot.
- **Schema changes:** edit `src/db/schema.ts`, run `npm run db:generate`, and commit the new file in `drizzle/` together with the code.
- **Pulling upstream changes into your fork:** read the new ADRs and migrations first. Your customized system prompt is the most likely merge conflict.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The bot doesn't answer at all | Wrong `TELEGRAM_AUTHORIZED_CHAT_ID` (check the logs for `dropped unauthorized update`), or you ran dev with the production token, which removed the webhook. Redeploy to register it again. |
| The app crashes on boot with a zod error | A required variable is missing or malformed. The error names it. |
| `/connect` says Strava or Google isn't configured | Client ID, client secret, or `TOKEN_ENCRYPTION_KEY` isn't set. |
| "This link has expired" | Connect links last 10 minutes and work once. Send `/connect` again. |
| No summary after an activity | `STRAVA_SUBSCRIPTION_ID` isn't set, the subscription points at an old URL (`strava:subscribe -- list`), or Strava isn't connected. Look for `rejected webhook event` in the logs. |
| Calendar booking fails with 403 | The Google Calendar API isn't enabled in your Cloud project. |
| Google asks you to reconnect every week | The consent screen is still in "Testing". Publish it. |
| Strava activities aren't renamed | The connection predates `activity:write`, or the box was unticked. Send `/reauth strava`. |
| Replies get shorter or come from the cheaper model | You've passed 90 % of the monthly budget. See `/budget`. |
| "Background task … failed" messages | Something failed outside a chat turn. The Railway logs have the details, with a `module` field. `/selftest` triggers a deliberate failure, to check that alerts work. |

---

**Next:** [Using the bot](03-using-the-bot.md)

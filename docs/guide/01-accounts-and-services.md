# 1. Accounts and services

This page lists every external service Croton uses: what it does, whether you need it, and how to get its credentials. Collect the values into a local `.env` file as you go (copy [`.env.example`](../../.env.example) first). [Setup and deployment](02-setup-and-deployment.md) then uses them.

Some steps need your public app URL, for example `https://your-app.up.railway.app`. Railway assigns it when you create the service (step 2 of the setup guide). You can create the Railway service early, or come back to those steps later.

| # | Service | Required | Env variables it gives you |
|---|---|---|---|
| 1 | [Telegram bot](#1-telegram-bot) | Yes | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_AUTHORIZED_CHAT_ID` |
| 2 | [Anthropic](#2-anthropic-claude-api) | Yes | `ANTHROPIC_API_KEY` |
| 3 | [Neon](#3-neon-postgres) | Yes | `DATABASE_URL` |
| 4 | [Railway](#4-railway-hosting) | Yes (or another host) | `APP_URL` |
| 5 | [Generated secrets](#5-secrets-you-generate-yourself) | Yes | `TELEGRAM_WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY`, `STRAVA_WEBHOOK_VERIFY_TOKEN` |
| 6 | [Strava](#6-strava-api-application) | Optional | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_SUBSCRIPTION_ID` |
| 7 | [Google Calendar](#7-google-cloud-calendar-api) | Optional | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| 8 | [Intervals.icu](#8-intervalsicu) | Optional | `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID` |
| 9 | [OpenAI](#9-openai-embeddings-only) | Optional | `OPENAI_API_KEY` |

---

## 1. Telegram bot

Telegram is the whole user interface. Bots are free, can send you messages first (which the Sunday recap needs), and support buttons.

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`. Pick a name and a username.
2. BotFather replies with a token like `123456789:AA...`. That is `TELEGRAM_BOT_TOKEN`. Treat it like a password: anyone with it can act as your bot.
3. **Create a second bot for development** the same way. Local development uses Telegram *long polling*, and starting polling deletes the bot's registered webhook. If you run locally with the production token, production silently stops receiving messages until its next deploy.
4. `TELEGRAM_AUTHORIZED_CHAT_ID` is your own chat ID. The bot ignores every other chat. You'll find it during the first deploy: the bot logs the chat ID of every message it drops. The setup guide shows how. You can also ask a bot such as [@userinfobot](https://t.me/userinfobot) for your user ID; in a private chat, the chat ID is the same as your user ID.

## 2. Anthropic (Claude API)

The coach runs on Claude: Sonnet for planning and analysis, Haiku for small talk and summaries.

1. Create an account at [console.anthropic.com](https://console.anthropic.com) and add a payment method or credits.
2. Under **API Keys**, create a key. That is `ANTHROPIC_API_KEY`.
3. Recommended: set a **monthly spend limit** in the console as well. The app enforces its own cap (`MONTHLY_LLM_BUDGET_EUR`, default 14), but a limit at the provider protects you even if the app has a bug.

Normal use costs roughly €3–6 a month. [ADR-005](../02-architecture-decisions.md#adr-005-thinking-and-effort-policy-per-call-type) has the breakdown.

## 3. Neon (Postgres)

All state lives here: conversations, activities, wellness, plans, goals, encrypted OAuth tokens, and the literature corpus.

1. Create a free account at [neon.tech](https://neon.tech) and a project. Choose the region closest to your Railway region.
2. Copy the connection string from the dashboard. Use the **direct** host, not the `-pooler` one. That is `DATABASE_URL`.

The app uses Neon's serverless HTTP driver (`@neondatabase/serverless`), so another Postgres provider would need a small change in `src/db/client.ts`. Migrations run automatically on every boot.

## 4. Railway (hosting)

Croton has to be always on and reachable over HTTPS: Telegram and Strava push webhooks to it, and the scheduler runs inside the process.

1. Create an account at [railway.com](https://railway.com) and connect your GitHub.
2. Create a project from your fork. Railway reads [`railway.json`](../../railway.json): it builds with `npm run build`, starts with `npm start`, and health-checks `/health`.
3. Under the service's **Settings → Networking**, generate a public domain. `https://<that domain>` is `APP_URL`.

The Hobby plan (~$5/month) is enough. Any other host works if it can run a long-lived Node 24 process with a public HTTPS URL, such as Fly.io, Render, or a VPS behind a reverse proxy. It must run **a single instance**, because the scheduler is in-process.

## 5. Secrets you generate yourself

These aren't issued by any service. Generate each one once and keep it in `.env` and in Railway's variables.

```sh
openssl rand -hex 32      # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32      # STRAVA_WEBHOOK_VERIFY_TOKEN
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY  (must decode to exactly 32 bytes)
```

- `TELEGRAM_WEBHOOK_SECRET`: Telegram sends it back in a header on every webhook call, so the app can reject forged updates. Required in production.
- `TOKEN_ENCRYPTION_KEY`: encrypts Strava and Google OAuth tokens in the database (AES-256-GCM). Strava and Google stay disabled without it. **If you lose or change it, the stored tokens can't be decrypted** and you have to reconnect both with `/reauth`.
- `STRAVA_WEBHOOK_VERIFY_TOKEN`: used once, in the handshake when you register the Strava webhook.

## 6. Strava API application

Strava provides your activities. It notifies the app of new uploads by webhook, and the app can rename a matched activity to the planned session's title.

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an application.
   - **Website:** your `APP_URL`.
   - **Authorization Callback Domain:** your app's hostname only, with no `https://` and no path (for example `your-app.up.railway.app`). Strava always accepts `localhost` as well, so local development works without changing this.
2. Copy the **Client ID** and **Client Secret** into `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`.
3. `STRAVA_SUBSCRIPTION_ID` comes later, when you register the webhook (setup guide, step 6).

A new Strava API app is limited to one connected athlete, which is all Croton needs. The app asks for `read,activity:read_all,activity:write`. If you untick `activity:write` on the consent screen, everything works except renaming activities.

## 7. Google Cloud (Calendar API)

Google Calendar is used to book confirmed sessions and to read your existing events, so the plan fits around them. The app only requests the `calendar.events` scope.

1. In the [Google Cloud Console](https://console.cloud.google.com), create a project.
2. **APIs & Services → Library:** enable the **Google Calendar API**. Without it, every booking fails with 403.
3. **Google Auth Platform → Branding:** fill in the app name and your email. Set:
   - **Application home page:** `APP_URL`
   - **Privacy policy:** `APP_URL/privacy`
   - **Authorized domain:** your app's full hostname

   Croton serves a minimal home page and privacy policy itself (`src/pages.ts`). Edit their wording if you like.
4. **Audience:** user type *External*. Then **publish the app** ("In production"). While an app is in "Testing", only listed test users can connect, and **refresh tokens expire after 7 days**. A published but unverified app is fine for personal use: you click through one "Google hasn't verified this app" warning when you connect.
5. **Clients → Create client → Web application.**
   - **Authorized redirect URIs:** `APP_URL/auth/google/callback`. To connect from local development too, add `http://localhost:3000/auth/google/callback`.
   - No JavaScript origins are needed.
6. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 8. Intervals.icu

[Intervals.icu](https://intervals.icu) is a free training-analysis platform and an official Garmin partner. Croton uses it as the bridge for Garmin data that Strava doesn't have: HRV, resting HR, sleep, stress, weight and body fat, CTL/ATL load, and your sport thresholds and zones. Garmin's own Health API is only available to business partners, and the unofficial login libraries break Garmin's terms. [ADR-015](../02-architecture-decisions.md#adr-015-health-data-comes-from-intervalsicu-not-terra) explains the choice.

1. Create an account and go to **Settings → Connections → Garmin**. Connect it and enable **Download wellness data**. Enable activity sync too, so CTL covers every workout.
2. Under **Settings → sport settings**, check that your FTP, LTHR, threshold pace and max HR are current. Croton imports them weekly.
3. Under **Settings → Developer Settings**, find your **API key** (`INTERVALS_API_KEY`) and **athlete ID** (`INTERVALS_ATHLETE_ID`, for example `i12345`).

Using a different watch brand? If it syncs to Intervals.icu (Coros, Polar, Suunto and Wahoo do), the same setup works, but check which wellness fields actually arrive. Weight from a smart scale can get there through Garmin Connect, or through an iOS Shortcut that writes Intervals.icu's `weight` and `bodyFat` fields.

## 9. OpenAI (embeddings only)

Only the optional literature search uses OpenAI. It embeds text chunks with `text-embedding-3-small`. A full ingest of a few hundred chunks costs about a cent, but OpenAI requires a prepaid minimum (around $5), so turn auto-recharge off.

1. Create a key at [platform.openai.com](https://platform.openai.com/api-keys). That is `OPENAI_API_KEY`.

Without it, the app runs normally and the `search_literature` tool answers "not configured".

---

**Next:** [Setup and deployment](02-setup-and-deployment.md)

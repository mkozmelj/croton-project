# Security

Croton is a single-operator app: one deployment serves one athlete. This page describes what it protects, how each entry point is secured, the known limitations, and what you need to do as an operator.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting instead (**Security → Report a vulnerability** on this repository). Include steps to reproduce and the commit you tested.

## What's worth protecting

| Asset | Why it matters |
|---|---|
| Anthropic and OpenAI API keys | Anyone holding them can spend your money |
| Telegram bot token | Full control of the bot: read your messages, message you as the coach |
| Google OAuth tokens | Create, change and delete events in your primary calendar |
| Strava OAuth tokens | Read all your activities (including private ones and their GPS tracks) and edit their titles and descriptions |
| Your data in Postgres | Health data (HRV, sleep, weight, injuries), training history, conversations |
| The monthly AI budget | An attacker who can trigger AI calls burns it, and the coach goes quiet until the 1st |

## How each entry point is secured

Every public route is listed here. Anything not listed returns 404.

| Route | Protection |
|---|---|
| `POST /webhook/telegram` | Secret header `X-Telegram-Bot-Api-Secret-Token`, compared in constant time in `onRequest`, **before the body is parsed**. The bot token is never part of the URL. Then a grammY middleware drops every update whose chat isn't `TELEGRAM_AUTHORIZED_CHAT_ID`, without replying, so strangers can't tell the bot exists. That check covers messages and button taps alike. |
| `GET /webhook/strava` | Subscription handshake. Answers only if `hub.verify_token` matches (constant-time comparison). Logged at `warn` only, so the token never lands in request logs. |
| `POST /webhook/strava` | Strava doesn't sign events. The app accepts an event only when `subscription_id` equals `STRAVA_SUBSCRIPTION_ID` **and** `owner_id` equals the connected athlete. For creates and updates, it **re-fetches the activity from the Strava API** and ignores the payload. See the [known limitations](#known-limitations). |
| `GET /auth/{strava,google}/start` | Requires a live `state`: 24 random bytes, minted by the bot when you send `/connect`, valid for 10 minutes. Without it, nobody can start a flow that links *their* account to your bot. |
| `GET /auth/{strava,google}/callback` | Consumes the `state` with a single `DELETE … RETURNING`, so a replayed or concurrent callback fails. Checks the granted scopes. Query strings (the OAuth `code`) are never logged. |
| `GET /`, `/privacy`, `/health` | Static. No data is read. |

**Errors:** a 5xx response has an empty body, so no stack traces or internals reach the caller. It also sends a Telegram alert to you. Rejected authentication returns `401` with an empty body, logs a warning, and sends no alert, so random scanners can't spam you.

## Secrets and data at rest

- **Secrets live only in environment variables** (local `.env`, which git ignores, and Railway variables). `.env.example` contains no values. The full git history of this repository was checked for keys, tokens, connection strings, chat IDs, athlete IDs, GPS data and health values before it was made public.
- **OAuth tokens are stored encrypted** with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, random 96-bit IV per value, versioned format `v1.<iv>.<tag>.<ciphertext>`). A leaked database dump or `DATABASE_URL` doesn't expose usable Google or Strava tokens unless the key leaks too.
- **Logs are scrubbed at the logger:** pino redacts token, secret, password and authorization fields, and every known secret value (including the database password and the Intervals.icu basic-auth string) is replaced in serialized errors and stack traces. Request logs drop query strings.
- **Refresh tokens are re-saved on every refresh**, because Strava rotates them.

## Where your data goes

- **Anthropic:** every chat turn, plus the dynamic context. That includes your profile, thresholds, goals, recent activities, wellness data (HRV, sleep, weight), feedback and injury notes, and, during planning, your calendar events for the week. Read Anthropic's data-retention policy for API traffic.
- **OpenAI:** only the literature you ingest and your search queries, for embeddings. No health data.
- **Strava:** when a planned session is matched, its title and the *plan* (structure, targets, minutes done) are written to the activity. Wellness data and coach comments are never written there, because Strava descriptions are often public.
- **Google Calendar:** planned sessions as events.

## Known limitations

These come from the pre-publication review. They are accepted for a single-user hobby deployment, but you should know about them.

1. **Forged Strava `delete` and deauthorization events.** Strava events aren't signed. The `subscription_id` and `owner_id` checks keep out random traffic, but neither value is a real secret: your Strava athlete ID is in your public profile URL, and subscription IDs are small integers. Someone who knows or guesses both could send:
   - a `delete` event for any activity ID. The app deletes that activity, and its feedback, from **its own database** without asking Strava. Nothing on Strava itself is affected, and `/import` restores it, minus the feedback.
   - an athlete event with `authorized: "false"`. The app deletes the stored Strava tokens until you `/reauth strava`.
   - a `create` event for an activity your account can see. The app re-fetches it from Strava (so it can't invent data), but it doesn't check that the fetched activity is *yours*. It also triggers a summary, which costs a fraction of a cent of the AI budget.

   *Mitigation, not yet implemented:* confirm deletes and deauthorizations against the Strava API before acting (a `404` for the activity, a failing token refresh), and compare the fetched activity's `athlete.id` with the connected athlete.
2. **No rate limiting on public routes.** Rejections are cheap, but a valid-looking Strava POST costs one database read. Railway's edge provides no per-IP limits by default. A determined flood mostly costs Neon compute time.
3. **Prompt injection through outside text.** Calendar event titles (anyone can send you an invite), Strava activity names and descriptions, and ingested articles all reach the model as context. The model can't write anything without your tap: proposals are rendered from their stored data, and calendar bookings only touch events the app created itself. So the realistic impact is a misleading reply or proposal. Read proposals before you tap Confirm.
4. **No key-rotation tool for `TOKEN_ENCRYPTION_KEY`.** The `v1` prefix leaves room for one. Today, rotating the key means setting a new one and reconnecting both services with `/reauth`.
5. **Development-only dependency advisories.** `npm audit` reports moderate advisories in `drizzle-kit`'s esbuild loader. `drizzle-kit` is a dev dependency used only to generate migrations locally, so it isn't in the production bundle. `npm audit --omit=dev` is clean.
6. **The failure-alert streak lives in memory**, so a restart can repeat one alert.

## Operator checklist

When you deploy your own copy:

- [ ] Use a **separate dev bot**. Never run local polling with the production token.
- [ ] Generate every secret with `openssl rand` (see the [services guide](docs/guide/01-accounts-and-services.md#5-secrets-you-generate-yourself)). Never reuse one across services.
- [ ] Set a **monthly spend limit at Anthropic** (and OpenAI) as well as `MONTHLY_LLM_BUDGET_EUR`.
- [ ] Keep `TELEGRAM_WEBHOOK_SECRET` set in production. The app refuses to start without it.
- [ ] Publish the Google consent screen, but grant only `calendar.events`.
- [ ] Keep `data/` out of git. It holds your literature files and exports.
- [ ] In a public fork, **never commit real API responses as test fixtures**. Your Strava and Intervals.icu IDs, GPS polylines and health values would become public. Use fake values, as the existing fixtures do.
- [ ] Before each commit, check `git diff --cached` for `.env` files, keys (`sk-ant-`, `sk-`, `npg_`, `ghp_`, bot tokens like `<digits>:AA…`), connection strings with passwords, and real IDs.
- [ ] **If a secret ever reaches git, rotate it at the provider first.** Deleting it in a later commit doesn't un-publish it.
- [ ] Revoke access you no longer use: Strava → Settings → My Apps; Google Account → Security → Third-party access.

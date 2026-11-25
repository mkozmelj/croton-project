# Roadmap

What's still open. The reasons behind the design are in the [ADRs](docs/02-architecture-decisions.md), and finished work is in the git history.

## Open

### Planned workouts, completion and the dashboard

[ADR-021](docs/02-architecture-decisions.md#adr-021-planned-workouts-are-rows-with-a-status-and-a-session-type) stores each planned session as a row with a status and a session type; [ADR-022](docs/02-architecture-decisions.md#adr-022-a-read-only-dashboard-at-a-fixed-url-behind-a-telegram-login) adds the dashboard.

- [x] Review the `session_type` list in ADR-021.
- [x] `planned_workouts` table, `active_minutes`, two-row bricks, plan changes as `replaced` rows (migration `0007`), stored plans moved to rows on boot.
- [x] Deployed 2026-11-17: production moved 9 weeks into 55 session rows.
- [x] `npm run workouts:classify` on production (2026-11-25): 42 of 43 moved sessions got a real session type.
- [x] The 08:00 check-in (`src/agent/check-in.ts`, `src/bot/check-in.ts`) and the completion rate in the Sunday recap, `/status` and chat context (2026-11-25). Not deployed yet.
- [ ] After the deploy: the first 08:00 check-in arrives and its buttons save, and `/status` shows the 4-week rate. The first run also marks older sessions that never got a match as `skipped`.
- [x] Session-type history in plan generation (`src/agent/session-history.ts`): the last 3 sessions of each type over 12 weeks, the 4-week completion rate and weekday moves and skips, about 1.6k tokens.
- [ ] Check the next weekly plan progresses its repeated sessions (e.g. `bike_threshold` was 3x8 min three weeks running).
- [x] Dashboard: Telegram login, week, completion and session-type views (`src/dashboard/`). Deployed 2026-11-17.
- [x] `DASHBOARD_SESSION_SECRET` on Railway (production `/dashboard` redirects to the login page).
- [ ] `/setdomain` in BotFather for the Railway domain on the production bot, then sign in at `/dashboard`.
- [ ] Next release: drop the plan backup table (migration `0008`).

## Not doing

Decided 2026-11-25.

- Strava perceived exertion: confirming the shape of the `perceived_exertion` field. It stays parsed defensively ([ADR-018](docs/02-architecture-decisions.md#adr-018-post-activity-feedback-lives-in-its-own-table)).
- Scanned books: ingesting *The Triathlete's Training Bible* and *Daniels' Running Formula*, and the chapter distillation into `STATIC_SYSTEM_PROMPT`. The literature corpus stays as it is ([ADR-014](docs/02-architecture-decisions.md#adr-014-literature-corpus--sourcing-and-ingestion)).

## Ideas, not planned

- Compare planned intervals with what was actually done, from the activity's laps or FIT file. This would fill `planned_workouts.main_set`, add intensity to the `partial` status, and give the planner and dashboard main-set numbers (ADR-021).
- Race-time prediction from fitness markers and load.
- Injury-risk flags from ACWR and HRV trends.
- Voice messages, transcribed and handled like text.

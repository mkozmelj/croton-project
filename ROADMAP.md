# Roadmap

What's still open. The reasons behind the design are in the [ADRs](docs/02-architecture-decisions.md), and finished work is in the git history.

## Open

### Strava perceived exertion

Phase 6 (post-activity feedback, planned titles on Strava, the hardened webhook) was checked in production on 2026-10-01.

- [ ] Set a perceived exertion on an activity in the Strava app. Confirm the shape of the `perceived_exertion` field (it isn't in Strava's published API reference), and record it in a test fixture with fake values. Until then it's parsed defensively ([ADR-018](docs/02-architecture-decisions.md#adr-018-post-activity-feedback-lives-in-its-own-table)).

### Literature: scanned books

[ADR-014](docs/02-architecture-decisions.md#adr-014-literature-corpus--sourcing-and-ingestion) explains why books come in as scans of print copies.

- [ ] Scan and ingest *The Triathlete's Training Bible* (5th ed.) and *Daniels' Running Formula* (4th ed.) (`npm run ingest -- <file> --type book_scan`).
- [ ] Distillation pass: summarize each chapter into rules, numbers and when they apply, and merge the notes into `STATIC_SYSTEM_PROMPT` by hand. Then check that prompt caching still hits (`cache_read_input_tokens` on the second call).

### Watch workouts

[ADR-020](docs/02-architecture-decisions.md#adr-020-planned-sessions-go-to-the-watch-through-intervalsicu) sends planned sessions to Garmin through Intervals.icu.

- [ ] Enable **Upload planned workouts** in Intervals.icu → Settings → Connections → Garmin. Today it's off, and so is Garmin training access.
- [x] First pool swim from the watch (2026-11-12): steps and pace targets worked; rests showed as 0 m swims, fixed with step intensity.
- [ ] Check the next swim's rests (rest steps, last rest in a repeat, total distance), and one run and one bike: repeats, and that pace ranges and % LTHR heart-rate targets arrive as targets, not notes.

### Planned workouts, completion and the dashboard

[ADR-021](docs/02-architecture-decisions.md#adr-021-planned-workouts-are-rows-with-a-status-and-a-session-type) stores each planned session as a row with a status and a session type; [ADR-022](docs/02-architecture-decisions.md#adr-022-a-read-only-dashboard-at-a-fixed-url-behind-a-telegram-login) adds the dashboard.

- [x] Review the `session_type` list in ADR-021.
- [x] `planned_workouts` table, `active_minutes`, two-row bricks, plan changes as `replaced` rows (migration `0007`), stored plans moved to rows on boot.
- [x] Deployed 2026-11-17: production moved 9 weeks into 55 session rows.
- [x] `npm run workouts:classify` on production (2026-11-25): 42 of 43 moved sessions got a real session type.
- [ ] Status rules, the 08:00 check-in, the completion rate in the Sunday recap and `/status`.
- [x] Session-type history in plan generation (`src/agent/session-history.ts`): the last 3 sessions of each type over 12 weeks, the 4-week completion rate and weekday moves and skips, about 1.6k tokens.
- [ ] Check the next weekly plan progresses its repeated sessions (e.g. `bike_threshold` was 3x8 min three weeks running).
- [x] Dashboard: Telegram login, week, completion and session-type views (`src/dashboard/`). Deployed 2026-11-17.
- [ ] Dashboard setup: `DASHBOARD_SESSION_SECRET` on Railway (`openssl rand -hex 32`), `/setdomain` in BotFather for the Railway domain on the production bot, then sign in at `/dashboard`.
- [ ] Next release: drop the plan backup table (migration `0008`).

## Ideas, not planned

- Compare planned intervals with what was actually done, from the activity's laps or FIT file. This would fill `planned_workouts.main_set`, add intensity to the `partial` status, and give the planner and dashboard main-set numbers (ADR-021).
- Race-time prediction from fitness markers and load.
- Injury-risk flags from ACWR and HRV trends.
- Voice messages, transcribed and handled like text.

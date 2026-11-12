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

## Ideas, not planned

- Compare planned intervals with what was actually done, from the activity's laps or FIT file.
- Race-time prediction from fitness markers and load.
- Injury-risk flags from ACWR and HRV trends.
- A small web dashboard for trends.
- Voice messages, transcribed and handled like text.

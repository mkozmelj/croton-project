# Roadmap

What's still open. The reasons behind the design are in the [ADRs](docs/02-architecture-decisions.md), and finished work is in the git history.

## Open

### Check Phase 6 in production

Post-activity feedback ([ADR-018](docs/02-architecture-decisions.md#adr-018-post-activity-feedback-lives-in-its-own-table)) and planned titles on Strava ([ADR-019](docs/02-architecture-decisions.md#adr-019-a-matched-strava-activity-takes-the-planned-sessions-title-and-description)) are deployed but not yet checked against real activities.

- [ ] Send `/reauth strava` to grant `activity:write`, then record a planned session. It should be renamed on Strava, with the plan in its description.
- [ ] Record a planned interval session. The summary should be followed by the full question set (RPE, feel, pain, note). Tap answers: one `activity_feedback` row should appear, and the message should show the answers. Change the RPE: the same row should update.
- [ ] Record a short easy session. Only the RPE question should be asked.
- [ ] Tap "Add a note" and send a message. It should be stored as the note, and the next message should go to normal chat.
- [ ] Rename the activity in Strava. The stored feedback should stay unchanged.
- [ ] Set a perceived exertion on an activity in the Strava app. Confirm that the `perceived_exertion` field arrives (it isn't in Strava's published API reference), and record its shape in a test fixture.
- [ ] After the webhook hardening (ADR-012, 2026-10-01): a new activity still gets its summary. The fetched activity must carry `athlete.id`.

### Literature: scanned books

[ADR-014](docs/02-architecture-decisions.md#adr-014-literature-corpus--sourcing-and-ingestion) explains why books come in as scans of print copies.

- [ ] Scan and ingest *The Triathlete's Training Bible* (5th ed.) and *Daniels' Running Formula* (4th ed.) (`npm run ingest -- <file> --type book_scan`).
- [ ] Distillation pass: summarize each chapter into rules, numbers and when they apply, and merge the notes into `STATIC_SYSTEM_PROMPT` by hand. Then check that prompt caching still hits (`cache_read_input_tokens` on the second call).

## Ideas, not planned

- Compare planned intervals with what was actually done, from the activity's laps or FIT file.
- Race-time prediction from fitness markers and load.
- Injury-risk flags from ACWR and HRV trends.
- A small web dashboard for trends.
- Voice messages, transcribed and handled like text.

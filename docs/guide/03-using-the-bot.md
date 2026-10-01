# 3. Using the bot

Once set up, Croton is a chat. Most of the time you write to it in plain language. Commands are shortcuts.

## Commands

| Command | What it does |
|---|---|
| `/start` | Welcome message and command list. Offers onboarding if your background is still empty. |
| `/recap` | Starts the weekly recap. From Friday to Sunday it plans next week; from Monday to Thursday it re-plans the rest of this week. |
| `/plan` | This week's plan. |
| `/tomorrow` | Tomorrow's sessions. |
| `/goals` | Season goals with weeks to go and the current training phase. |
| `/profile` | Fitness markers (with date and source), zones, background, and anything stale or missing. `/profile help` lists the edit commands. |
| `/onboard` | A short conversation about your training background. |
| `/status` | This week's training, recovery (HRV, sleep, resting HR, load), connection status and budget. |
| `/import` | Loads 12 months of Strava activities and 90 days of wellness data. Safe to repeat. |
| `/connect [strava\|calendar]` | Sends a one-time link to connect a service. |
| `/reauth [strava\|calendar]` | The same thing, for when access expired or was revoked. |
| `/budget` | AI spend this month, by model. |
| `/deep <question>` | Forces the stronger model, with more thinking, for one question. |
| `/selftest` | (Hidden) Makes a background task fail on purpose, so you can check that error alerts reach you. |

### Editing your profile

```text
/profile ftp 250
/profile lthr run 168
/profile maxhr 190
/profile pace 4:15              threshold run pace per km
/profile css 1:45               critical swim speed per 100 m
/profile vdot 48.5
/profile vdot 10k 45:30         VDOT worked out from a race result
/profile availability Mon-Fri 1h before work, long sessions at weekends
/profile injuries Left Achilles, no speed work on track
/profile name Alex
/profile ftp 255 2026-09-20     optional trailing date: when it was measured
```

Each edit is shown with a Confirm button first. Values are range-checked to catch typos. Zones can't be edited directly: they're recalculated from your thresholds.

## The weekly cycle

**Sunday 19:00: recap.** The bot asks how the week went. Answer freely: how you felt, niggles, sleep, what's coming next week ("away Wednesday to Friday, hotel gym only"). It then:

1. compares planned and actual training, including session-RPE load and the feedback you gave;
2. looks at recovery trends (HRV, resting HR, sleep, CTL/ATL/ramp rate);
3. checks your calendar for the coming week;
4. replies with a written recap and a proposed week, as a separate message with **Confirm** and **Cancel**.

Confirm saves the plan and books each session in Google Calendar. If something goes wrong, for example an expired Google token, the buttons stay and you can tap Confirm again once it's fixed. A proposal expires after 24 hours.

**During the week.** Ask anything:

- "What's on tomorrow?"
- "I've got a work dinner Thursday, can we move the intervals?" A new week proposal follows, again with buttons.
- "How's my run volume trending over the last six weeks?"
- "Is it worth doing a brick this early in base?"

**After every workout.** Strava notifies the bot, and you get:

1. the activity's numbers with a short coach comment;
2. if it was a planned field test, or it clearly beat a threshold, a proposed new FTP, VDOT or threshold pace to confirm;
3. one-tap questions: RPE (1–10), and for key sessions also how it felt and whether anything hurt. "Add a note" lets you type a comment. If you set a perceived exertion in Strava, it's used and not asked again.

If the activity matches a planned session, it's renamed on Strava to the session's title, and the plan is added to its description. Wellness data and the coach's comments never go to Strava, because Strava descriptions are often public.

## Confirmations: nothing is written without a tap

The AI can *propose* goals, profile changes, fitness markers and week plans. The bot renders each proposal from the data that would actually be saved, not from the model's wording, and attaches buttons. Only a tap writes to the database or the calendar. A double tap runs once.

## Which model answers

Each message is routed by simple rules:

- **Claude Sonnet** gets anything about your training: days, sessions, sports, plans, races, thresholds, your own trends. It's also used for a few minutes after a Sonnet reply, so "yes, do it" keeps its context.
- **Claude Haiku** gets greetings, thanks, and general knowledge questions that don't mention you or your plan.
- `/deep` forces Sonnet with more thinking.

## Budget levels

All Claude and OpenAI spend is costed per call and summed per calendar month against `MONTHLY_LLM_BUDGET_EUR` (default €14):

| Spend | What happens |
|---|---|
| < 75 % | Normal |
| 75 % | One alert |
| 90 % | Haiku only, and an alert |
| ~96 % | Minimal mode: AI calls are refused. Commands that read saved data, such as `/plan` and `/tomorrow`, still work, and activity summaries show the numbers without a comment |
| 100 % | Hard stop until the 1st of next month |

`/budget` shows where you are.

## Memory

The last 20 messages go into every conversation. Once a month, messages older than 60 days are summarized into short notes and deleted. The latest notes stay in context, so the coach remembers that your knee flared up in spring without keeping every message forever.

## Alerts

If anything fails in the background (a sync job, a Strava event, a token refresh, a crash), you get a short Telegram message, and the details go to the logs. Repeated failures of the same job alert once, plus once more when it works again.

---

**Next:** [Customizing](04-customizing.md)

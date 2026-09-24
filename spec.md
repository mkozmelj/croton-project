# Training Agent — Project Specification

> Master reference for implementation via Claude Code.
> Every architectural decision, constraint, and implementation detail lives here.

---

## 1. Vision

An always-on AI training agent for a single amateur multi-sport athlete (triathlon, tennis, trail running). The agent lives in a Telegram chat, has access to real training data (Strava, Garmin/Apple Health, body composition), knows the athlete's calendar, and builds structured weekly training plans grounded in established sports science. It runs continuously in the cloud on a hard budget of €20/month.

### 1.1 Core User Stories

1. **Sunday Recap & Planning**: Every Sunday evening, the agent nudges me in Telegram. I share how the week went, how I feel, and what's coming next week. The agent pulls my actual training data, compares planned vs actual, and generates next week's plan with full workout structures. It books the sessions on my Google Calendar.

2. **Mid-week Chat**: Any time during the week, I message the agent: "I have a tennis match Thursday, move my tempo run." The agent checks my calendar, reshuffles the plan, updates calendar events, and confirms.

3. **Progress Tracking**: I ask "How's my running volume trending?" or "Am I ready for the half marathon in March?" The agent queries my training history and gives a grounded answer.

4. **Training Knowledge**: I ask "Should I do brick workouts this early in base phase?" The agent answers from sports science principles, referencing periodization theory.

5. **Passive Monitoring**: Each time I finish a workout, the agent logs it and sends a quick summary in Telegram ("Nice Z2 run — 8.2km, 52min. Weekly volume: 4.2h.").

### 1.2 What the Agent Does NOT Do

- It does not adjust plans mid-week unless I ask.
- It does not give medical advice or diagnose injuries.
- It does not auto-purchase anything.
- It does not share data with anyone.

---

## 2. Architecture Overview

```
┌─────────────┐     webhook      ┌──────────────────────────────────┐
│  Telegram    │◄───────────────►│  Node.js Backend (Railway)       │
│  (chat UI)   │                 │                                  │
└─────────────┘                  │  ┌────────────────────────────┐  │
                                 │  │  Agent Orchestrator         │  │
                                 │  │  - Message handler          │  │
                                 │  │  - Model router (Sonnet/    │  │
                                 │  │    Haiku based on task)     │  │
                                 │  │  - Budget tracker           │  │
                                 │  │  - Conversation memory      │  │
                                 │  └─────────┬──────────────────┘  │
                                 │            │                     │
                                 │  ┌─────────▼──────────────────┐  │
                                 │  │  Claude API                 │  │
                                 │  │  + MCP: Strava              │  │
                                 │  │  + MCP: Google Calendar     │  │
                                 │  │  + Tools: health metrics    │  │
                                 │  │  + Tools: training plans    │  │
                                 │  │  + Tools: literature search │  │
                                 │  │  + Tools: athlete profile   │  │
                                 │  └────────────────────────────┘  │
                                 │                                  │
                                 │  ┌────────────────────────────┐  │
                                 │  │  Scheduler (node-cron)      │  │
                                 │  │  - Sunday 19:00 CET nudge   │  │
                                 │  │  - Daily health data check  │  │
                                 │  └────────────────────────────┘  │
                                 │                                  │
                                 │  ┌────────────────────────────┐  │
                                 │  │  Webhook Receiver           │  │
                                 │  │  - /webhook/telegram        │  │
                                 │  │  - /webhook/strava          │  │
                                 │  │  - /webhook/terra           │  │
                                 │  └────────────────────────────┘  │
                                 └──────────────┬───────────────────┘
                                                │
                                 ┌──────────────▼───────────────────┐
                                 │  Neon PostgreSQL (free tier)      │
                                 │  - athlete_profile                │
                                 │  - activities                     │
                                 │  - health_metrics                 │
                                 │  - training_plans                 │
                                 │  - conversations                  │
                                 │  - llm_usage (budget tracking)    │
                                 │  - literature_chunks (+ vectors)  │
                                 └──────────────────────────────────┘

External data sources:
  ┌──────────────┐
  │ Garmin Watch  │──► Garmin Connect ──┐
  │ Xiaomi Scale  │──► Mi Fitness ──────► Apple Health ──┐
  └──────────────┘                      │                │
                                 ┌──────▼────────────────▼──────┐
                                 │ Terra API (free tier)         │
                                 │ Connects to Garmin Connect    │
                                 │ + Apple Health via companion  │
                                 │ app. Pushes via webhook.      │
                                 └──────────────────────────────┘
```

### 2.1 Data Flow Summary

| Source | Data | Path to Backend |
|--------|------|-----------------|
| Garmin watch | Sleep, HRV, stress, Body Battery, resting HR | Garmin Connect → Terra API → webhook |
| Xiaomi Mi Scale | Weight, body fat %, muscle mass, BMI | Mi Fitness → Apple Health → Terra API → webhook |
| Strava | Activities (detailed: pace, HR, power, laps, segments) | Strava MCP via Claude API (or REST API fallback) |
| Google Calendar | Availability, scheduled events | Google Calendar MCP via Claude API (or REST API fallback) |
| TrainingPeaks | 2024 Olympic triathlon training history | One-time CSV/FIT export → imported into DB + system prompt examples |
| Athlete (me) | Goals, races, preferences, weekly recap, ad-hoc requests | Telegram chat |

### 2.2 Key Architectural Principle: MCP-First with REST Fallback

The Claude API supports passing MCP server URLs in the `mcp_servers` parameter. The agent attempts to use:
- **Strava MCP** (`https://mcp.strava.com/mcp`) for activity data
- **Google Calendar MCP** (`https://calendarmcp.googleapis.com/mcp/v1`) for calendar read/write

If MCP auth doesn't work with the Claude API (see Risk R-01), the fallback is direct REST API integration exposed as custom function-calling tools. The architecture is identical either way — only the integration layer changes.

Both paths require OAuth2 authentication. The backend handles token refresh automatically.

---

## 3. Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Language | TypeScript (Node.js 24 LTS) | Matches existing skills, type safety, good ecosystem |
| Runtime | Node.js with tsx | Fast dev, native TS execution |
| Framework | Fastify | Lightweight, fast, good webhook handling |
| Database | Neon (PostgreSQL, free tier) | Serverless Postgres, no pause risk, pgvector if needed, 0.5GB free |
| ORM | Drizzle | Type-safe, lightweight, excellent migrations |
| LLM | Claude API (Sonnet 4.6 + Haiku 4.5) | Best reasoning, native MCP support |
| Chat | Telegram Bot API (via grammy) | Free, great DX, supports rich formatting, bot can initiate messages |
| Scheduler | node-cron | In-process, no extra service, reliable for single-instance |
| Hosting | Railway ($5/mo hobby plan) | Always-on, simple deploys from GitHub, supports persistent processes |
| Health Bridge | Terra API (free tier) | Connects directly to Garmin Connect + Apple Health; pushes all health metrics (incl. HRV) via webhook. Free for 500 users. |
| Vector Search | In-memory (cosine similarity) | ~500 chunks, instant, no extra dependency |
| CI/CD | Railway auto-deploy from GitHub main branch | Push to main = deploy, zero config |

### 3.1 Key Dependencies (npm)

```
grammy                  # Telegram bot framework
@anthropic-ai/sdk       # Claude API client
@neondatabase/serverless # Neon PostgreSQL driver
drizzle-orm             # Type-safe ORM
drizzle-kit             # Migration tooling
fastify                 # HTTP server for webhooks
node-cron               # Scheduled tasks
dotenv                  # Environment config
```

---

## 4. Data Model

### 4.1 Schema (Drizzle)

```
athlete_profile
├── id: serial PK
├── name: text
├── sport_zones: jsonb          # { run: { z1: [0,130], z2: [130,150], ... }, bike: {...}, swim: {...} }
├── race_calendar: jsonb        # [{ name, date, type, priority, goal_time? }]├── current_phase: text         # 'base' | 'build' | 'peak' | 'race' | 'recovery'
├── phase_started_at: date
├── vdot: numeric               # Running fitness indicator
├── ftp: numeric                 # Cycling FTP
├── css: numeric                 # Critical swim speed
├── injury_notes: text
├── preferences: jsonb           # { preferred_run_days, long_run_day, rest_days, ... }
├── updated_at: timestamp

activities
├── id: serial PK
├── external_id: text UNIQUE     # Strava activity ID or Terra reference ID
├── source: text                 # 'strava' | 'terra' | 'trainingpeaks_import'
├── sport: text                  # 'run' | 'bike' | 'swim' | 'tennis' | 'strength' | 'trail_run' | ...
├── started_at: timestamp
├── duration_seconds: int
├── distance_meters: numeric
├── elevation_gain_meters: numeric
├── avg_hr: int
├── max_hr: int
├── avg_pace_per_km: numeric     # seconds per km (running)
├── avg_power: numeric           # watts (cycling)
├── training_load: numeric       # TSS or equivalent
├── zone_distribution: jsonb     # { z1: 600, z2: 1800, z3: 300, ... } in seconds
├── laps: jsonb                  # structured intervals if available
├── notes: text                  # athlete notes
├── raw_data: jsonb              # full payload for reference
├── created_at: timestamp

health_metrics
├── id: serial PK
├── date: date UNIQUE
├── sleep_duration_minutes: int
├── sleep_quality_score: numeric  # 0-100 if available
├── deep_sleep_minutes: int
├── rem_sleep_minutes: int
├── resting_hr: int
├── hrv_ms: numeric               # HRV in milliseconds (RMSSD)
├── body_battery: int              # Garmin Body Battery (0-100)
├── stress_avg: int                # Garmin stress score
├── weight_kg: numeric
├── body_fat_pct: numeric
├── muscle_mass_kg: numeric
├── bmi: numeric
├── raw_data: jsonb
├── created_at: timestamp

training_plans
├── id: serial PK
├── week_start: date              # Monday of the planned week
├── phase: text                   # training phase during this week
├── plan: jsonb                   # full structured plan (see 4.2)
├── planned_volume: jsonb         # { run_km, bike_km, swim_km, total_hours }
├── actual_volume: jsonb          # filled in retrospectively
├── compliance_pct: numeric       # how well the plan was followed
├── recap_notes: text             # athlete's Sunday recap notes
├── agent_analysis: text          # agent's weekly analysis
├── created_at: timestamp

conversations
├── id: serial PK
├── role: text                    # 'user' | 'assistant'
├── content: text
├── telegram_message_id: bigint
├── tokens_used: int
├── model: text                   # 'sonnet' | 'haiku'
├── created_at: timestamp

llm_usage
├── id: serial PK
├── date: date
├── model: text
├── input_tokens: int
├── output_tokens: int
├── cost_eur: numeric(10,6)
├── call_type: text               # 'chat' | 'recap' | 'plan' | 'activity_summary' | 'embedding'
├── created_at: timestamp

literature_chunks
├── id: serial PK
├── source: text                  # book title or paper reference
├── chapter: text
├── content: text                 # the chunk text
├── embedding: vector(1536)       # OpenAI text-embedding-3-small
├── created_at: timestamp
```

### 4.2 Training Plan Structure (JSON)

```json
{
  "week_number": 12,
  "phase": "build",
  "focus": "Increasing threshold run volume, maintaining swim consistency",
  "days": {
    "monday": {
      "type": "rest",
      "notes": "Full rest or light stretching"
    },
    "tuesday": {
      "type": "run",
      "title": "Tempo Intervals",
      "duration_minutes": 55,
      "structure": [
        { "segment": "warmup", "duration": "15min", "zone": "Z1-Z2", "description": "Easy jog" },
        { "segment": "main", "duration": "3x8min", "zone": "Z3-Z4", "recovery": "3min Z1", "description": "Tempo intervals at threshold pace" },
        { "segment": "cooldown", "duration": "10min", "zone": "Z1", "description": "Easy jog + stretching" }
      ],
      "target_metrics": { "pace_range": "4:40-4:55/km", "hr_range": "155-170" },
      "calendar_event_id": "gcal_xxx"
    },
    "wednesday": {
      "type": "swim",
      "title": "CSS Intervals",
      "duration_minutes": 45,
      "structure": [
        { "segment": "warmup", "duration": "400m", "description": "Mixed stroke easy" },
        { "segment": "main", "duration": "8x100m", "zone": "Z4", "recovery": "20sec", "description": "At CSS pace" },
        { "segment": "cooldown", "duration": "200m", "description": "Easy backstroke" }
      ]
    }
  },
  "weekly_targets": {
    "total_hours": 7.5,
    "run_km": 35,
    "bike_km": 80,
    "swim_km": 3.5,
    "intensity_distribution": { "z1_z2_pct": 82, "z3_z5_pct": 18 }
  }
}
```

---

## 5. System Prompt — Training Intelligence

The system prompt is the agent's core brain. It contains the training principles that govern all plan generation. The agent does NOT need to retrieve these from RAG — they are always in context.

### 5.1 System Prompt Structure

```
ROLE:
You are a personal training coach for [athlete name], an amateur multi-sport
athlete. You build and manage training plans grounded in sports science.

ATHLETE PROFILE:
[Injected from athlete_profile table — zones, FTP, VDOT, race calendar,
current phase, preferences, injury notes]

CURRENT CONTEXT:
[Injected dynamically — current week's plan, last 7 days of activities,
today's health metrics, upcoming calendar events]

TRAINING PRINCIPLES:
[See 5.2 below — the sports science foundation]

TOOLS AVAILABLE:
[Descriptions of custom tools + MCP capabilities]

BEHAVIOR RULES:
- Generate full workout structures with warmup, main set, cooldown
- Use the athlete's actual zones and paces, not generic ones
- Follow the 80/20 intensity distribution (80% Z1-Z2, 20% Z3+)
- Respect the current periodization phase
- Never exceed a 10% weekly volume increase
- Include a recovery/deload week every 3-4 weeks
- When adjusting plans mid-week, preserve weekly intensity distribution
- When booking calendar events, check for conflicts first
- Always confirm plan changes before writing to calendar
- Use metric units (km, kg)
- Respond in English
- Be concise in daily chat, thorough in weekly recaps
- If the athlete reports pain or injury symptoms, recommend rest and suggest consulting a professional — do not diagnose
```

### 5.2 Training Principles (Embedded in System Prompt)

This section captures the essential knowledge from the key literature. It is always in context (~3,000 tokens).

```
PERIODIZATION (Friel, Bompa):
- Annual plan divided into macrocycles anchored to target races
- Phases: Preparation (Base) → Specific Preparation (Build) → Competition (Peak/Race) → Transition (Recovery)
- Base phase: 8-12 weeks. Focus on aerobic volume, technique, strength foundation. Low intensity.
- Build phase: 6-8 weeks. Introduce race-specific intensity. Maintain volume, increase intensity.
- Peak phase: 2-3 weeks. Reduce volume 40-60%, maintain intensity. Sharpening.
- Race week: Taper. Volume drops 50-70%. 2-3 short openers with race-pace strides.
- Recovery/Transition: 2-4 weeks post-race. Unstructured, cross-training, mental reset.
- Mesocycle: 3-4 week blocks. Weeks 1-3 progressive load. Week 4 recovery (volume -30-40%).
- Microcycle: 7-day structure. Hard/easy alternation. No more than 2 consecutive hard days.

INTENSITY DISTRIBUTION (Fitzgerald, Seiler):
- 80/20 rule: ~80% of training time in Z1-Z2, ~20% in Z3-Z5.
- Polarized > threshold-heavy for amateur athletes.
- Z1 (Recovery): RPE 1-2. Active recovery.
- Z2 (Aerobic): RPE 3-4. Conversational. The bulk of training.
- Z3 (Tempo): RPE 5-6. Comfortably hard. Use sparingly.
- Z4 (Threshold): RPE 7-8. Sustainable for 30-60min. Race pace for Olympic distance.
- Z5 (VO2max): RPE 9-10. Intervals of 2-5min. High training stimulus.

RUNNING (Daniels):
- VDOT as fitness indicator. Use to set training paces.
- E (Easy) runs: Foundation. 60-75% of weekly volume.
- T (Threshold) runs: 20-30min at threshold pace, or cruise intervals.
- I (Interval) runs: 3-5min reps at VO2max pace. Total: 8-10% of weekly volume.
- R (Repetition) runs: Short, fast reps for economy.
- Long run: 25-30% of weekly volume, not exceeding 2.5h for amateurs.
- Weekly mileage increase: max 10% per week.

TRIATHLON SPECIFICS:
- Brick workouts: Bike→Run combination. Essential for race-day adaptation. 1x/week in build phase.
- Swim technique > swim volume for amateurs.
- Discipline priority: Allocate training time proportional to race-leg duration, adjusted for weakness.
- Olympic distance typical split: Swim 1.5km / Bike 40km / Run 10km.
- Transition practice: Include in brick sessions.

TRAIL RUNNING:
- Elevation gain (D+) as primary load metric alongside distance.
- Specificity: Train on similar terrain and elevation profile.
- Downhill running: Eccentric load, requires specific preparation.
- Poles: Train with them if racing with them.
- Nutrition strategy critical for efforts >90min.

RECOVERY & LOAD MANAGEMENT:
- Acute:Chronic Workload Ratio (ACWR): Keep between 0.8-1.3. Above 1.5 = injury risk.
- HRV trend: Declining trend over 3+ days = accumulated fatigue. Consider reducing load.
- Sleep: <6h significantly impairs recovery. Flag when metrics show poor sleep.
- Resting HR: Elevation of 5+ bpm above baseline = incomplete recovery or illness.
- Body composition: Track trends, not daily fluctuations. Weekly averages.
- Deload week every 3-4 weeks: Reduce volume 30-40%, maintain some intensity.

MULTI-SPORT SCHEDULING:
- Tennis is non-periodized and counts as a moderate-intensity session.
- After competitive tennis: Treat as a hard day. Plan easy or rest the next day.
- Cross-training benefit: Cycling volume supports running aerobic base.
- Swim sessions are low-impact and can serve as active recovery.

WORKOUT FORMAT:
Always structure workouts as:
1. Warmup: Duration, zone, description
2. Main Set: Intervals or steady state with zone, pace/power targets, recovery
3. Cooldown: Duration, zone, description
Include target metrics (pace range, HR range, power range) based on athlete's current zones.
```

### 5.3 RAG Layer (In-Memory Vector Search)

For specific questions beyond the core principles, the agent searches embedded literature chunks. Implementation:

1. At startup, load all `literature_chunks` rows into memory as a `Map<id, { content, embedding }>`.
2. On a `search_literature` tool call, compute cosine similarity against the query embedding.
3. Return top 3-5 most relevant chunks as context for the LLM.
4. Embeddings generated via OpenAI `text-embedding-3-small` (cheapest, ~$0.02/1M tokens).

Literature sources to chunk and embed:
- Publicly available training articles from TrainingPeaks, Uphill Athlete, Scientific Triathlon
- Stephen Seiler's research papers on polarized training (open access)
- Joe Friel's blog posts (public)
- Key chapters from athlete-provided digital copies (if available)
- The 2024 Olympic triathlon training history from TrainingPeaks (as reference examples)

---

## 6. Agent Behavior

### 6.1 Model Router

Each incoming message is classified before the LLM call:

| Classification | Model | Examples |
|---------------|-------|----------|
| `plan_generation` | Sonnet | Sunday recap, generate weekly plan |
| `plan_adjustment` | Sonnet | "Move Thursday's run", "Add a swim session" |
| `analysis` | Sonnet | "How's my running volume trending?", "Am I on track?" |
| `quick_chat` | Haiku | "What's my plan for tomorrow?", "Thanks!", greeting |
| `activity_summary` | Haiku | Auto-triggered on Strava webhook, summarize new activity |
| `knowledge_qa` | Haiku (+ RAG if needed) | "What's a good brick workout?", "Should I taper 2 or 3 weeks?" |

Classification logic: keyword matching + heuristic (message length, question marks, presence of day/schedule words). If uncertain, default to Haiku. The user can force Sonnet by starting a message with `/deep`.

### 6.2 Conversation Memory

- Store all messages in `conversations` table.
- For each Claude API call, include the last 20 messages as conversation history.
- For Sunday recaps, also inject: current week's plan, all activities from the past 7 days, latest health metrics, and the athlete profile.
- Monthly: summarize older conversations and store summary as a "memory" entry. Drop raw messages older than 60 days.

### 6.3 Telegram Bot Commands

| Command | Action |
|---------|--------|
| `/start` | Welcome message, setup instructions |
| `/recap` | Trigger Sunday recap flow manually |
| `/plan` | Show current week's plan |
| `/tomorrow` | Show tomorrow's planned workout |
| `/status` | Current phase, weekly volume, budget remaining |
| `/profile` | Show/edit athlete profile |
| `/deep <message>` | Force Sonnet model for this message |
| `/budget` | Show LLM spend this month |

### 6.4 Sunday Recap Flow

1. **19:00 CET Sunday**: Cron triggers. Agent sends Telegram message: "Ready for the weekly recap! How did the week go? Any niggles, fatigue, or things I should know about next week?"
2. **Athlete responds** with subjective feedback and upcoming schedule.
3. **Agent pulls data**: Strava activities (via MCP or API), health metrics (from DB), current plan (from DB).
4. **Agent generates**:
   - Week summary: planned vs actual volume, intensity distribution, notable sessions
   - Recovery assessment: HRV trend, sleep quality, subjective feedback
   - Next week's plan: full structured workouts for each day
5. **Agent asks for confirmation**: Shows the plan summary. "Want me to book these on your calendar?"
6. **On confirmation**: Creates Google Calendar events (via MCP or API) for each planned session.

### 6.5 Activity Notification Flow

1. Strava webhook fires on new activity.
2. Backend verifies webhook signature.
3. Backend calls Claude (Haiku) with activity data + week's plan.
4. Agent sends Telegram message: "Solid tempo run — 8.1km in 42:36, avg HR 158. That's 3 of 5 planned sessions done this week. Running volume at 22km / 35km target."

---

## 7. Integration Details

### 7.1 Strava

**Primary path: MCP via Claude API**
```typescript
mcp_servers: [{
  type: "url",
  url: "https://mcp.strava.com/mcp",
  name: "strava",
  authorization_token: `Bearer ${stravaAccessToken}`
}]
```

**Fallback: REST API with custom tools**
- OAuth2 flow: Authorization code → access token + refresh token
- Webhook subscription for new activities (POST to `/webhook/strava`)
- Endpoints: `GET /athlete/activities`, `GET /activities/{id}/streams`
- Token refresh: Strava tokens expire; backend refreshes automatically using stored refresh token.

**OAuth setup (one-time, manual)**:
1. Create Strava API application at https://www.strava.com/settings/api
2. Set callback URL to `https://<railway-url>/auth/strava/callback`
3. Authorize via browser, backend captures and stores tokens in DB.

### 7.2 Google Calendar

**Primary path: MCP via Claude API**
```typescript
mcp_servers: [{
  type: "url",
  url: "https://calendarmcp.googleapis.com/mcp/v1",
  name: "gcal",
  authorization_token: `Bearer ${googleAccessToken}`
}]
```

**Fallback: REST API with custom tools**
- Google Calendar API v3
- OAuth2 with offline access (refresh token)
- Scopes: `calendar.events`, `calendar.readonly`

**OAuth setup (one-time, manual)**:
1. Create project in Google Cloud Console.
2. Enable Calendar API.
3. Create OAuth2 credentials (Web application).
4. Set redirect URI to `https://<railway-url>/auth/google/callback`.
5. Authorize via browser.

**Calendar event format**:
```json
{
  "summary": "🏃 Tempo Intervals (55min)",
  "description": "Warmup 15min Z1-Z2 → 3×8min Z3-Z4 (3min recovery) → Cooldown 10min Z1\nTarget: 4:40-4:55/km, HR 155-170",
  "start": { "dateTime": "2027-01-07T07:00:00+01:00" },
  "end": { "dateTime": "2027-01-07T07:55:00+01:00" },
  "colorId": "9",
  "reminders": { "useDefault": false, "overrides": [{ "method": "popup", "minutes": 30 }] }
}
```

### 7.3 Health Data (via Terra API)

Terra API connects directly to **Garmin Connect** and **Apple Health**, solving the problem that Garmin does not sync HRV to Apple Health via HealthKit. Terra pulls HRV, sleep stages, stress, and Body Battery straight from Garmin Connect's cloud, and body composition from Apple Health (where Xiaomi Mi Fitness syncs it).

**Why Terra over Health Auto Export**: Garmin does not export HRV to Apple Health. Health Auto Export reads from Apple Health, so it would miss HRV entirely — the most important recovery metric. Terra connects to Garmin Connect directly and gets the full dataset.

**Free tier**: 500 users. More than sufficient for 1 athlete.

**Setup (manual)**:
1. Create Terra developer account at https://dashboard.tryterra.co
2. Get API key and dev ID from Terra dashboard.
3. Install Terra companion app on iPhone.
4. Link Garmin Connect in the Terra app (OAuth flow within the app).
5. Link Apple Health in the Terra app (permissions prompt).
6. Configure webhook destination in Terra dashboard: `https://<railway-url>/webhook/terra`

**Data flow**:
- Terra syncs from Garmin Connect every ~15-30 minutes (configurable).
- Terra syncs from Apple Health when the companion app is opened or on schedule.
- On new data, Terra sends a webhook POST to the backend with the payload.

**Webhook handler**:
- Endpoint: `POST /webhook/terra`
- Verify Terra webhook signature using dev ID.
- Parse payload: Terra sends structured JSON with `type` field indicating data category (`activity`, `sleep`, `body`, `daily`).
- Upsert into `health_metrics` table by date.

**Key Terra data types used**:
| Terra Type | Data | Maps To |
|-----------|------|---------|
| `sleep` | Duration, stages (deep/light/REM/awake), sleep score | `health_metrics.sleep_*` |
| `daily` | HRV (RMSSD), resting HR, stress, Body Battery | `health_metrics.hrv_ms`, `resting_hr`, etc. |
| `body` | Weight, body fat %, muscle mass, BMI | `health_metrics.weight_kg`, `body_fat_pct`, etc. |

**Fallback**: If Terra changes pricing or becomes unavailable, Health Auto Export (~€3/mo) can cover everything except HRV. For HRV-only fallback, a manual Garmin Connect export or the unofficial Garmin Connect Python library (`garminconnect`) could be used as a cron job.

### 7.4 TrainingPeaks (One-time Import)

1. Export 2024 Olympic triathlon training plan from TrainingPeaks (CSV or .fit files).
2. Parse and import into `activities` table with `source: 'trainingpeaks_import'`.
3. Extract workout structures as example templates for the system prompt.
4. Embed notable training blocks as reference in `literature_chunks`.

---

## 8. Budget Control System

### 8.1 Hard Cap: €20/month

Budget allocation:

| Item | Monthly Cost | Fixed/Variable |
|------|-------------|---------------|
| Railway hosting | €5.00 | Fixed |
| Terra API | €0.00 | Fixed (free tier) |
| Claude API (LLM) | €1-5 (cap: €14) | Variable |
| OpenAI embeddings | < €0.50 | Variable (mostly one-time) |
| **Total** | **€6-10** | **Cap: €19.50** |

Buffer: €10-14 depending on LLM usage. Switching from Health Auto Export to Terra (free) saves ~€3/mo, and the LLM cap is raised to €14 since there are no other paid services beyond Railway.

### 8.2 LLM Cost Tracking

Every Claude API call is logged in `llm_usage`:
```typescript
async function trackUsage(model: string, inputTokens: number, outputTokens: number, callType: string) {
  const cost = calculateCost(model, inputTokens, outputTokens);
  await db.insert(llmUsage).values({ date: today(), model, inputTokens, outputTokens, costEur: cost, callType });
}
```

Cost calculation (approximate, verify current pricing):
- Sonnet: $3.00/1M input, $15.00/1M output → ~€2.75/1M input, €13.80/1M output
- Haiku: $0.80/1M input, $4.00/1M output → ~€0.74/1M input, €3.68/1M output

### 8.3 Budget Enforcement

```
Monthly LLM spend thresholds (cap: €14):
  < €10.50  → Normal operation (Sonnet for complex, Haiku for simple)
  €10.50    → Telegram alert: "75% of LLM budget used"
  €12.60    → Switch ALL calls to Haiku only. Alert: "90% — Haiku-only mode"
  €13.50    → Minimal mode. Only respond to /plan and /tomorrow with cached data. Alert: "Budget nearly exhausted. Full service resumes on the 1st."
  €14.00    → Hard stop. Refuse all LLM calls. Canned response only.
```

Budget resets on the 1st of each month.

### 8.4 Cost Estimates Per Interaction

| Interaction | Model | Est. Tokens (in/out) | Est. Cost |
|-------------|-------|---------------------|-----------|
| Sunday recap + plan gen | Sonnet | 15K / 3K | ~€0.08 |
| Mid-week plan adjustment | Sonnet | 10K / 1.5K | ~€0.05 |
| Quick Q&A | Haiku | 5K / 500 | ~€0.006 |
| Activity summary | Haiku | 3K / 300 | ~€0.003 |

Monthly estimate (typical usage):
- 4 Sunday recaps: €0.32
- 8 plan adjustments: €0.40
- 60 quick chats: €0.36
- 20 activity summaries: €0.06
- **Total: ~€1.14/mo**

This is well under the €11 cap, leaving significant headroom.

---

## 9. Deployment & CI/CD

### 9.1 Railway Setup

```toml
# railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 5

[service]
internalPort = 3000
```

### 9.2 Deployment Flow

1. Code lives in a GitHub repository.
2. Railway connects to the repo's `main` branch.
3. Every push to `main` triggers auto-deploy.
4. Railway builds with Nixpacks (auto-detects Node.js), runs the start command.
5. Drizzle migrations run on startup (`migrate()` in index.ts).

### 9.3 Environment Variables

```env
# Telegram
TELEGRAM_BOT_TOKEN=           # from BotFather
TELEGRAM_WEBHOOK_SECRET=       # random string for webhook verification

# Claude API
ANTHROPIC_API_KEY=             # from console.anthropic.com

# Neon
DATABASE_URL=                  # from Neon dashboard

# Strava
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_ACCESS_TOKEN=           # set after initial OAuth
STRAVA_REFRESH_TOKEN=          # set after initial OAuth

# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_ACCESS_TOKEN=           # set after initial OAuth
GOOGLE_REFRESH_TOKEN=          # set after initial OAuth

# Terra API
TERRA_API_KEY=                 # from Terra dashboard
TERRA_DEV_ID=                  # from Terra dashboard
TERRA_SIGNING_SECRET=          # for webhook signature verification

# OpenAI (for embeddings only)
OPENAI_API_KEY=

# App
APP_URL=                       # Railway-assigned URL
TIMEZONE=Europe/Ljubljana
MONTHLY_LLM_BUDGET_EUR=14.00
```

---

## 10. Project Structure

```
training-agent/
├── src/
│   ├── index.ts                    # Entry: Fastify server, bot setup, cron, migrations
│   ├── config/
│   │   └── env.ts                  # Typed env variables with validation
│   ├── bot/
│   │   ├── setup.ts                # Grammy bot init + webhook config
│   │   ├── handlers.ts             # Message & command handlers
│   │   └── commands.ts             # /start, /recap, /plan, /tomorrow, /status, /budget
│   ├── agent/
│   │   ├── orchestrator.ts         # Route message → classify → call Claude → respond
│   │   ├── classifier.ts           # Message type classification (plan/chat/analysis)
│   │   ├── claude.ts               # Claude API client wrapper
│   │   ├── system-prompt.ts        # Dynamic system prompt builder
│   │   ├── tools.ts                # Custom tool definitions for function calling
│   │   ├── tool-handlers.ts        # Execute tool calls (query DB, etc.)
│   │   └── budget.ts               # Cost tracking & enforcement
│   ├── integrations/
│   │   ├── strava/
│   │   │   ├── oauth.ts            # OAuth flow + token refresh
│   │   │   ├── webhook.ts          # Strava webhook handler
│   │   │   └── client.ts           # REST API client (fallback)
│   │   ├── google/
│   │   │   ├── oauth.ts            # OAuth flow + token refresh
│   │   │   └── calendar.ts         # Calendar API client (fallback)
│   │   └── terra/
│   │       ├── webhook.ts          # Terra API webhook handler
│   │       └── parser.ts           # Parse Terra payload types (sleep, daily, body)
│   ├── db/
│   │   ├── client.ts               # Neon + Drizzle client
│   │   ├── schema.ts               # All table definitions
│   │   └── queries.ts              # Reusable query functions
│   ├── knowledge/
│   │   ├── embeddings.ts           # In-memory vector search
│   │   ├── loader.ts               # Load chunks from DB into memory on startup
│   │   └── ingest.ts               # CLI script to chunk & embed literature
│   ├── scheduler/
│   │   └── cron.ts                 # Sunday nudge, daily health check
│   └── utils/
│       ├── tokens.ts               # Token counting & cost calculation
│       └── formatting.ts           # Telegram message formatting helpers
├── data/
│   ├── literature/                 # Source text files for embedding
│   └── trainingpeaks/              # Exported training history
├── drizzle/
│   └── migrations/                 # Auto-generated SQL migrations
├── drizzle.config.ts
├── package.json
├── tsconfig.json
├── railway.toml
├── Dockerfile                      # Optional, Railway can use Nixpacks
├── .env.example
└── README.md
```

---

## 11. Risk Assessment

| ID | Risk | Impact | Likelihood | Mitigation |
|----|------|--------|-----------|------------|
| R-01 | Claude API `mcp_servers` doesn't support passing OAuth bearer tokens for Strava/Google Calendar | Medium — need to write REST API integration code instead | Medium | Fallback architecture already designed. Custom tools via function calling achieve the same result with ~200 extra lines of code. Test MCP auth in Phase 1 before building REST fallback. |
| R-02 | Terra API changes pricing or becomes unavailable | Medium — lose health data pipeline | Low | Fallback: Health Auto Export (~€3/mo) covers everything except HRV. For HRV specifically, unofficial `garminconnect` Python library as a cron job. Agent functions without health data (just loses recovery insights). |
| R-03 | Strava API rate limits (100 requests/15min for read, 1000/day) | Low — single user, low frequency | Very Low | Cache activity data in DB. Query Strava only for new data. Webhook-driven sync avoids polling. |
| R-04 | Railway free credits expire / pricing changes | Medium — hosting cost increase | Low | Railway hobby plan is $5/mo, well within budget. Alternative: Fly.io or Render with similar pricing. Service is portable (just Docker + env vars). |
| R-05 | Neon free tier limits hit (0.5GB storage, 191 compute hours) | Low — data is tiny | Very Low | Even with 5 years of data: <100MB. Compute hours: single-user queries won't approach limit. Monitor via Neon dashboard. |
| R-06 | LLM costs spike unexpectedly | Medium — could blow monthly budget | Low | Hard budget enforcement with graduated throttling (see Section 8.3). Token counting before and after each call. Alerts at 75% and 90%. |
| R-07 | Token refresh fails (Strava or Google) | Medium — agent loses data access | Medium | Implement retry with exponential backoff. Alert via Telegram if refresh fails 3 times. Manual re-auth flow via `/reauth` command. |
| R-08 | Claude API deprecates current model versions | Low — need to update model strings | Medium | Pin specific model versions in config. Subscribe to Anthropic changelog. Update is a one-line env var change. |
| R-09 | ~~Garmin data doesn't sync to Apple Health for all metrics~~ **RESOLVED** | — | — | Confirmed: Garmin does NOT sync HRV to Apple Health. Resolved by switching to Terra API, which connects directly to Garmin Connect and gets HRV, sleep (without gaps), stress, and Body Battery. |
| R-10 | Conversation context grows too large (token budget) | Low — responses slow, costs increase | Medium | Hard cap at 20 messages in context. Summarize older conversations monthly. Keep system prompt lean (<4K tokens). |

---

## 12. Manual Setup Steps (Martin's Checklist)

These cannot be automated and must be done by hand before or during implementation.

### 12.1 One-time Account Creation

| # | Step | Where | Time |
|---|------|-------|------|
| 1 | Create Railway account, link GitHub | railway.app | 5 min |
| 2 | Create Neon account, provision a database | neon.tech | 5 min |
| 3 | Create Telegram bot via BotFather, get token | Telegram @BotFather | 2 min |
| 4 | Create Strava API application | strava.com/settings/api | 5 min |
| 5 | Create Google Cloud project, enable Calendar API, create OAuth credentials | console.cloud.google.com | 15 min |
| 6 | Get Anthropic API key | console.anthropic.com | 2 min |
| 7 | Get OpenAI API key (for embeddings) | platform.openai.com | 2 min |
| 8 | Create Terra developer account, get API key + dev ID | dashboard.tryterra.co | 5 min |

### 12.2 One-time Configuration

| # | Step | Time |
|---|------|------|
| 9 | Authorize Strava OAuth via browser (after backend is deployed) | 2 min |
| 10 | Authorize Google Calendar OAuth via browser (after backend is deployed) | 2 min |
| 11 | Switch primary calendar to Google Calendar (if not already) | 15 min |
| 12 | Install Terra companion app on iPhone, link Garmin Connect + Apple Health within app | 10 min |
| 13 | Configure Terra webhook destination in Terra dashboard | 2 min |
| 14 | Export TrainingPeaks 2024 data (CSV/FIT) | 5 min |
| 15 | Provide athlete profile data to agent (zones, race calendar, preferences) | 15 min |

**Total manual effort: ~1.5 hours**, spread across the implementation phases.

### 12.3 What Claude Code Handles

Everything else:
- GitHub repo creation and structure
- All application code
- Database schema and migrations
- Railway deployment configuration
- Telegram webhook setup (via API call)
- Strava webhook subscription (via API call)
- Literature chunking and embedding pipeline
- System prompt crafting
- Testing

---

## 13. Implementation Phases

### Phase 1: Skeleton (Target: 1 session)

**Goal**: Telegram bot running on Railway, connected to Claude API, with basic chat.

- [ ] Init repo with TypeScript, Fastify, Grammy
- [ ] Set up Neon database + Drizzle schema (conversations, llm_usage)
- [ ] Implement Claude API wrapper with budget tracking
- [ ] Implement Telegram webhook handler
- [ ] Basic system prompt (training principles, no data yet)
- [ ] Deploy to Railway
- [ ] Set Telegram webhook URL
- [ ] Test: send messages, get responses, costs logged

**Manual steps needed**: #1-3, #6 from checklist.

### Phase 2: Data Layer (Target: 1-2 sessions)

**Goal**: Agent sees real training data and health metrics.

- [ ] Implement Strava integration (MCP first, REST fallback)
- [ ] Implement Strava webhook for activity notifications
- [ ] Implement Terra API webhook handler (sleep, daily, body payloads)
- [ ] Full database schema (activities, health_metrics, athlete_profile)
- [ ] Activity summary on new Strava activity → Telegram notification
- [ ] `/status` command showing current metrics

**Manual steps needed**: #4, #8, #9, #12, #13 from checklist.

### Phase 3: Calendar & Planning (Target: 1-2 sessions)

**Goal**: Weekly plan generation and calendar integration.

- [ ] Implement Google Calendar integration (MCP first, REST fallback)
- [ ] Build training plan generation prompt chain
- [ ] Implement Sunday cron job + recap flow
- [ ] Plan → Calendar event creation
- [ ] Mid-week plan adjustment capability
- [ ] `/recap`, `/plan`, `/tomorrow` commands

**Manual steps needed**: #5, #10, #11 from checklist.

### Phase 4: Intelligence (Target: 1 session)

**Goal**: Literature-backed knowledge and training history reference.

- [ ] Literature chunking and embedding pipeline
- [ ] In-memory vector search implementation
- [ ] Import TrainingPeaks 2024 data
- [ ] `search_literature` tool for Claude
- [ ] Refine system prompt with example workouts from TrainingPeaks history

**Manual steps needed**: #7, #14 from checklist.

### Phase 5: Polish (Target: 1 session)

**Goal**: Reliability, monitoring, and athlete profile.

- [ ] Conversation memory management (summarization, cleanup)
- [ ] Graduated budget enforcement with alerts
- [ ] Model router (classify → Sonnet or Haiku)
- [ ] Token refresh error handling and alerts
- [ ] `/profile` command (view/edit zones, race calendar)
- [ ] `/budget` command
- [ ] Health check endpoint
- [ ] Error notification to Telegram on failures
- [ ] Athlete profile onboarding flow (first-time setup via chat)

**Manual steps needed**: #15 from checklist.

---

## 14. Testing Strategy

| Level | What | How |
|-------|------|-----|
| Unit | Token cost calculation, message classification, health data parsing | Vitest, mocked data |
| Integration | Strava webhook handling, calendar event creation, DB queries | Vitest with test database |
| System | Full flow: Telegram message → Claude → tool calls → response | Manual + logged in test Telegram chat |
| Budget | Verify throttling at each threshold | Simulate spend by inserting llm_usage rows |
| Resilience | Token refresh failure, webhook timeout, API errors | Inject failures, verify alerts |

**No automated end-to-end testing** — this is a single-user tool. Manual testing via the actual Telegram bot is the most efficient approach. Log everything for debugging.

---

## 15. Future Enhancements (Out of Scope for V1)

- **Garmin MCP** if one becomes available — could replace Terra API as the health data bridge
- **Workout execution tracking**: Parse Garmin .fit files to compare planned intervals vs actual
- **Performance prediction**: Estimate race times based on training load and fitness trends
- **Injury risk scoring**: Based on ACWR and HRV trends
- **Training visualization dashboard**: Web UI showing trends (could be a Next.js app)
- **Voice input**: Telegram voice messages transcribed and processed
- **Multi-athlete support**: Scale to coach others (out of scope, but architecture would support it)

---

## Appendix A: Key Terminology

| Term | Definition |
|------|-----------|
| VDOT | Jack Daniels' running fitness indicator based on race performance |
| FTP | Functional Threshold Power — max sustainable cycling power for 1 hour |
| CSS | Critical Swim Speed — swimming equivalent of threshold pace |
| TSS | Training Stress Score — quantified training load per session |
| ACWR | Acute:Chronic Workload Ratio — 7-day vs 28-day rolling load average |
| HRV | Heart Rate Variability (RMSSD) — indicator of autonomic recovery |
| Brick | Back-to-back sessions in two disciplines (typically bike→run) |
| Mesocycle | 3-4 week training block within a phase |
| Microcycle | 1-week training structure |
| Polarized | Training distribution with most volume easy and some very hard, avoiding moderate |

## Appendix B: Reference Literature

| Source | Use | Access |
|--------|-----|--------|
| Joe Friel — Triathlete's Training Bible | Periodization, phase planning, annual plan | Requires digital copy |
| Jack Daniels — Running Formula | VDOT, training paces, workout structures | Requires digital copy |
| Matt Fitzgerald — 80/20 Running/Triathlon | Intensity distribution | Requires digital copy |
| Tudor Bompa — Periodization | Macro/meso/micro cycle theory | Requires digital copy |
| Stephen Seiler (various papers) | Polarized training evidence | Open access on PubMed/ResearchGate |
| TrainingPeaks blog/articles | Practical application, TSS, CTL/ATL | Publicly available |
| Uphill Athlete articles | Trail/mountain sport specifics | Publicly available |
| Scientific Triathlon podcast/articles | Evidence-based triathlon training | Publicly available |
| Martin's 2024 Olympic tri plan | Personal reference workouts | TrainingPeaks export |

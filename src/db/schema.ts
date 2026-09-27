import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Background } from "../training/background.js";
import { MARKER_METRICS, MARKER_SOURCES, MARKER_SPORTS } from "../training/markers.js";
import type { SportZones } from "../training/zones.js";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
// Upserts set `updated_at` explicitly; $onUpdate covers plain updates.
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const decimal = (name: string) => numeric(name, { mode: "number" });

// ADR-003: `content` is the full Anthropic content-block array, exactly as sent/received.
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: jsonb("content").$type<ContentBlockParam[]>().notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    tokensUsed: integer("tokens_used"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_created_at_idx").on(table.createdAt)],
);

// spec.md §6.2: a summary of conversation turns older than 60 days, which are then deleted
// (src/agent/memory.ts). ADR-009: upserted on `through_turn_id`, the last turn it covers, so
// a run that fails between storing the summary and deleting the turns doesn't store it twice.
export const conversationMemories = pgTable("conversation_memories", {
  id: serial("id").primaryKey(),
  throughTurnId: integer("through_turn_id").notNull().unique(),
  // Local dates of the first and last summarized turn.
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  summary: text("summary").notNull(),
  turnCount: integer("turn_count").notNull(),
  createdAt: createdAt(),
});

// One row per Claude API call. `date` is the local (TIMEZONE) calendar date, so the
// monthly budget resets at local midnight on the 1st.
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: serial("id").primaryKey(),
    date: date("date", { mode: "string" }).notNull(),
    model: text("model").notNull(),
    callType: text("call_type").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    costEur: numeric("cost_eur", { precision: 10, scale: 6, mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("llm_usage_date_idx").on(table.date)],
);

// ADR-011: one row per provider, both tokens AES-256-GCM encrypted (src/integrations/oauth-crypto.ts).
// `account_id` is the provider's id for the athlete (Strava: athlete id, checked against
// webhook `owner_id`, ADR-012).
export const oauthTokens = pgTable("oauth_tokens", {
  provider: text("provider", { enum: ["strava", "google"] }).primaryKey(),
  accountId: text("account_id"),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ADR-011: single-use OAuth `state`, deleted when the callback consumes it.
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider", { enum: ["strava", "google"] }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export type LapSummary = {
  name: string;
  elapsedSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  avgHr: number | null;
  avgWatts: number | null;
};

// ADR-009: `external_id` is unique, every write is an upsert on it.
export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    externalId: text("external_id").notNull().unique(),
    source: text("source", { enum: ["strava", "trainingpeaks_import"] }).notNull(),
    sport: text("sport").notNull(),
    name: text("name"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    elapsedSeconds: integer("elapsed_seconds"),
    distanceMeters: decimal("distance_meters"),
    elevationGainMeters: decimal("elevation_gain_meters"),
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),
    avgPacePerKm: decimal("avg_pace_per_km"),
    avgPower: decimal("avg_power"),
    trainingLoad: decimal("training_load"),
    zoneDistribution: jsonb("zone_distribution").$type<Record<string, number>>(),
    laps: jsonb("laps").$type<LapSummary[]>(),
    notes: text("notes"),
    rawData: jsonb("raw_data").$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("activities_started_at_idx").on(table.startedAt)],
);

export const ACTIVITY_FEELS = ["awful", "meh", "good", "strong"] as const;
export const RPE_SOURCES = ["athlete", "strava"] as const;

// ADR-018: the athlete's answers about one activity. A table of its own so the activity
// upserts (ADR-009) can never overwrite them; upserted on `activity_id`, one field at a time.
export const activityFeedback = pgTable(
  "activity_feedback",
  {
    id: serial("id").primaryKey(),
    activityId: integer("activity_id")
      .notNull()
      .unique()
      .references(() => activities.id, { onDelete: "cascade" }),
    rpe: integer("rpe"),
    rpeSource: text("rpe_source", { enum: RPE_SOURCES }),
    feel: text("feel", { enum: ACTIVITY_FEELS }),
    // null: not answered.
    pain: boolean("pain"),
    painNote: text("pain_note"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check("activity_feedback_rpe_range", sql`${table.rpe} between 1 and 10`)],
);

// ADR-009: one row per local date, upserted on `date`. An upsert only sets the columns it
// has values for; `raw_data` keeps the latest record per source (ADR-015: { intervals }).
export const healthMetrics = pgTable("health_metrics", {
  id: serial("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull().unique(),
  sleepDurationMinutes: integer("sleep_duration_minutes"),
  sleepQualityScore: decimal("sleep_quality_score"),
  deepSleepMinutes: integer("deep_sleep_minutes"),
  remSleepMinutes: integer("rem_sleep_minutes"),
  restingHr: integer("resting_hr"),
  hrvMs: decimal("hrv_ms"),
  bodyBattery: integer("body_battery"),
  stressAvg: integer("stress_avg"),
  weightKg: decimal("weight_kg"),
  bodyFatPct: decimal("body_fat_pct"),
  muscleMassKg: decimal("muscle_mass_kg"),
  bmi: decimal("bmi"),
  // ADR-016: Intervals.icu's fitness (CTL), fatigue (ATL) and ramp rate, from the same record.
  ctl: decimal("ctl"),
  atl: decimal("atl"),
  rampRate: decimal("ramp_rate"),
  rawData: jsonb("raw_data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Single-row table (id is always 1). No `race_calendar` (replaced by events/goals, ADR-010)
// and no `current_phase`: the phase is derived from weeks to the A event, never stored.
// Thresholds (FTP, VDOT, CSS, ...) live in `fitness_markers` (ADR-016); `sport_zones` is the
// snapshot derived from them, rewritten whenever a marker changes.
export const athleteProfile = pgTable(
  "athlete_profile",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name"),
    sportZones: jsonb("sport_zones").$type<SportZones>(),
    background: jsonb("background").$type<Background>(),
    injuryNotes: text("injury_notes"),
    preferences: jsonb("preferences").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check("athlete_profile_single_row", sql`${table.id} = 1`)],
);

// ADR-010: every goal hangs off a dated event.
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    sport: text("sport").notNull(),
    distance: text("distance"),
    location: text("location"),
    calendarEventId: text("calendar_event_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("events_date_idx").on(table.date)],
);

export const goals = pgTable(
  "goals",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    season: integer("season").notNull(),
    priority: text("priority", { enum: ["A", "B", "C"] }).notNull(),
    goalType: text("goal_type", { enum: ["finish", "time", "placing", "pb"] }).notNull(),
    target: text("target"),
    targetSeconds: integer("target_seconds"),
    notes: text("notes"),
    status: text("status", { enum: ["active", "achieved", "missed", "dropped"] })
      .notNull()
      .default("active"),
    result: text("result"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Exactly one active A goal per season.
    uniqueIndex("goals_one_active_a_per_season")
      .on(table.season)
      .where(sql`${table.priority} = 'A' and ${table.status} = 'active'`),
    check("goals_priority_valid", sql`${table.priority} in ('A', 'B', 'C')`),
    check(
      "goals_status_valid",
      sql`${table.status} in ('active', 'achieved', 'missed', 'dropped')`,
    ),
  ],
);

// ADR-016: dated threshold history. The current value is the latest row per (sport, metric).
export const fitnessMarkers = pgTable(
  "fitness_markers",
  {
    id: serial("id").primaryKey(),
    sport: text("sport", { enum: MARKER_SPORTS }).notNull(),
    metric: text("metric", { enum: MARKER_METRICS }).notNull(),
    value: decimal("value").notNull(),
    measuredOn: date("measured_on", { mode: "string" }).notNull(),
    source: text("source", { enum: MARKER_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (table) => [
    // ADR-009 upsert target.
    uniqueIndex("fitness_markers_sport_metric_day_source").on(
      table.sport,
      table.metric,
      table.measuredOn,
      table.source,
    ),
  ],
);

export const PENDING_ACTION_TYPES = [
  // Confirmations: written only after the athlete taps Confirm.
  "set_goal",
  "update_profile",
  "add_fitness_marker",
  "apply_plan",
  // Conversation modes.
  "recap",
  "onboarding",
  "activity_feedback",
] as const;

// ADR-007: state that must survive a restart. Two kinds share the table: confirmations
// (answered with a button, `payload` is what gets written) and conversation modes
// (`recap`, `onboarding`, `activity_feedback`: they change how the next message is handled).
export const pendingActions = pgTable(
  "pending_actions",
  {
    id: serial("id").primaryKey(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    actionType: text("action_type", { enum: PENDING_ACTION_TYPES }).notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("pending_actions_chat_idx").on(table.chatId, table.actionType)],
);

// One confirmed plan per training week (spec.md §4.1/§4.2). `plan` is validated with
// weekPlanSchema (src/training/plan.ts) when read; workouts carry their calendar event ids.
export const trainingPlans = pgTable("training_plans", {
  id: serial("id").primaryKey(),
  weekStart: date("week_start", { mode: "string" }).notNull().unique(),
  phase: text("phase"),
  plan: jsonb("plan").$type<unknown>().notNull(),
  recapNotes: text("recap_notes"),
  agentAnalysis: text("agent_analysis"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const LITERATURE_SOURCE_TYPES = ["paper", "article", "book_scan", "notes"] as const;

// ADR-014: the only stored copy of the corpus (source files stay in git-ignored
// data/literature/). Written only by the ingest CLI; `content_hash` makes re-runs idempotent.
// Search loads the rows for the current `embedding_model` into memory, so no pgvector.
export const literatureChunks = pgTable(
  "literature_chunks",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    sourceType: text("source_type", { enum: LITERATURE_SOURCE_TYPES }).notNull(),
    chapter: text("chapter"),
    section: text("section"),
    // Page or location, for citations.
    locator: text("locator"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embedding: real("embedding").array().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // ADR-009 upsert target.
    uniqueIndex("literature_chunks_source_hash").on(table.source, table.contentHash),
  ],
);

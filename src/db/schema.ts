import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
    source: text("source", { enum: ["strava", "terra", "trainingpeaks_import"] }).notNull(),
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

// ADR-009: one row per local date, upserted by every Terra payload type. Each type only
// sets its own columns; `raw_data` keeps the latest payload per type ({ sleep, daily, body }).
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
  rawData: jsonb("raw_data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ZoneRange = [low: number, high: number];
export type SportZones = Partial<Record<string, Record<string, ZoneRange>>>;

// Single-row table (id is always 1). No `race_calendar` (replaced by events/goals, ADR-010)
// and no `current_phase`: the phase is derived from weeks to the A event, never stored.
export const athleteProfile = pgTable(
  "athlete_profile",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name"),
    sportZones: jsonb("sport_zones").$type<SportZones>(),
    vdot: decimal("vdot"),
    ftp: decimal("ftp"),
    css: decimal("css"),
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

import { z } from "zod";
import type { HealthMetricsUpdate, HealthMetricValues } from "../../db/health-metrics.js";
import { localDate } from "../../utils/dates.js";

// Terra payload → health_metrics updates. Field paths follow Terra's data models
// (docs.tryterra.co, checked 2026-09-24). Every field is optional: providers fill
// different subsets, and a missing value must not overwrite a stored one.
//
// Column ownership per payload type, so two payloads for the same day never fight:
// - sleep: sleep durations, sleep score, HRV (overnight RMSSD is the recovery signal)
// - daily: resting HR, stress, Body Battery
// - body:  weight, body fat, muscle mass, BMI

const num = z.number().finite().nullish();

const metadata = z.object({ start_time: z.string(), end_time: z.string().nullish() });

const sleepSchema = z.object({
  metadata,
  sleep_durations_data: z
    .object({
      asleep: z
        .object({
          duration_asleep_state_seconds: num,
          duration_deep_sleep_state_seconds: num,
          duration_REM_sleep_state_seconds: num,
        })
        .nullish(),
    })
    .nullish(),
  scores: z.object({ sleep: num }).nullish(),
  heart_rate_data: z.object({ summary: z.object({ avg_hrv_rmssd: num }).nullish() }).nullish(),
});

const dailySchema = z.object({
  metadata,
  heart_rate_data: z.object({ summary: z.object({ resting_hr_bpm: num }).nullish() }).nullish(),
  stress_data: z
    .object({
      avg_stress_level: num,
      // BodyBatterySample's shape isn't spelled out in Terra's docs; `level` is assumed.
      // Verify against the first real Garmin payload (raw_data keeps it).
      body_battery_samples: z.array(z.object({ level: num })).nullish(),
    })
    .nullish(),
});

const bodySchema = z.object({
  metadata,
  measurements_data: z
    .object({
      day_avg_weight_kg: num,
      day_avg_bodyfat_percentage: num,
      day_avg_muscle_mass_g: num,
      day_avg_bmi: num,
    })
    .nullish(),
});

const envelopeSchema = z.object({
  type: z.string(),
  data: z.array(z.unknown()).nullish(),
  status: z.string().nullish(),
  user: z.object({ provider: z.string().nullish() }).nullish(),
});

export type TerraPayload =
  | { kind: "metrics"; updates: HealthMetricsUpdate[] }
  | { kind: "auth"; type: string; status: string | null; provider: string | null }
  | { kind: "ignored"; type: string };

// Terra events about the connection itself rather than data.
const AUTH_TYPES = new Set(["auth", "deauth", "user_reauth", "access_revoked", "connection_error"]);

const minutes = (seconds: number | null | undefined) =>
  seconds == null ? undefined : Math.round(seconds / 60);
const rounded = (value: number | null | undefined) =>
  value == null ? undefined : Math.round(value);
const value = (input: number | null | undefined) => input ?? undefined;

function sleepValues(item: z.infer<typeof sleepSchema>): HealthMetricValues {
  const asleep = item.sleep_durations_data?.asleep;
  return {
    sleepDurationMinutes: minutes(asleep?.duration_asleep_state_seconds),
    deepSleepMinutes: minutes(asleep?.duration_deep_sleep_state_seconds),
    remSleepMinutes: minutes(asleep?.duration_REM_sleep_state_seconds),
    sleepQualityScore: value(item.scores?.sleep),
    hrvMs: value(item.heart_rate_data?.summary?.avg_hrv_rmssd),
  };
}

function dailyValues(item: z.infer<typeof dailySchema>): HealthMetricValues {
  const levels = (item.stress_data?.body_battery_samples ?? [])
    .map((sample) => sample.level)
    .filter((level): level is number => level != null);
  return {
    restingHr: rounded(item.heart_rate_data?.summary?.resting_hr_bpm),
    stressAvg: rounded(item.stress_data?.avg_stress_level),
    // The day's peak is the morning charge after sleep — the number that reflects recovery.
    bodyBattery: levels.length > 0 ? Math.round(Math.max(...levels)) : undefined,
  };
}

function bodyValues(item: z.infer<typeof bodySchema>): HealthMetricValues {
  const measurements = item.measurements_data;
  const muscleG = measurements?.day_avg_muscle_mass_g;
  return {
    weightKg: value(measurements?.day_avg_weight_kg),
    bodyFatPct: value(measurements?.day_avg_bodyfat_percentage),
    muscleMassKg: muscleG == null ? undefined : Math.round(muscleG / 100) / 10,
    bmi: value(measurements?.day_avg_bmi),
  };
}

const PARSERS = {
  // A night belongs to the day you wake up on.
  sleep: (item: unknown) => {
    const sleep = sleepSchema.parse(item);
    return { at: sleep.metadata.end_time ?? sleep.metadata.start_time, values: sleepValues(sleep) };
  },
  daily: (item: unknown) => {
    const daily = dailySchema.parse(item);
    return { at: daily.metadata.start_time, values: dailyValues(daily) };
  },
  body: (item: unknown) => {
    const body = bodySchema.parse(item);
    return { at: body.metadata.start_time, values: bodyValues(body) };
  },
} as const;

function isMetricType(type: string): type is keyof typeof PARSERS {
  return Object.hasOwn(PARSERS, type);
}

export function parseTerraPayload(body: unknown, timeZone: string): TerraPayload {
  const envelope = envelopeSchema.parse(body);
  const { type } = envelope;

  if (AUTH_TYPES.has(type)) {
    return {
      kind: "auth",
      type,
      status: envelope.status ?? null,
      provider: envelope.user?.provider ?? null,
    };
  }
  if (!isMetricType(type)) return { kind: "ignored", type };

  const byDate = new Map<string, HealthMetricsUpdate>();
  for (const item of envelope.data ?? []) {
    const { at, values } = PARSERS[type](item);
    const instant = new Date(at);
    if (Number.isNaN(instant.getTime())) throw new Error(`invalid Terra timestamp in ${type}`);
    const date = localDate(instant, timeZone);
    const previous = byDate.get(date);
    // A nap and the night can land on the same date: the longest sleep is the night.
    if (
      type === "sleep" &&
      previous &&
      (previous.values.sleepDurationMinutes ?? 0) >= (values.sleepDurationMinutes ?? 0)
    ) {
      continue;
    }
    byDate.set(date, { date, source: type, values, raw: withoutSamples(item) });
  }
  return { kind: "metrics", updates: [...byDate.values()] };
}

// Terra's `*_samples` arrays hold per-second/per-minute series (HR, hypnogram, stress),
// hundreds of KB a day. Only the summaries are used, so raw_data keeps everything else —
// otherwise a year of payloads would crowd Neon's free-tier storage.
export function withoutSamples(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(withoutSamples);
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !key.endsWith("samples"))
      .map(([key, nested]) => [key, withoutSamples(nested)]),
  );
}

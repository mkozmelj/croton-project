import type { HealthMetricsUpdate } from "../../db/health-metrics.js";
import type { Wellness } from "./client.js";

export const INTERVALS_SOURCE = "intervals";

const BODY_BATTERY_KEY = /^body_?battery/i;

// Intervals.icu has no standard Body Battery field. If the Garmin sync (or a custom
// wellness field) adds one, it shows up as an extra numeric key named like "BodyBattery".
function bodyBattery(record: Wellness): number | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (BODY_BATTERY_KEY.test(key) && typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value);
    }
  }
  return undefined;
}

const round = (value: number | null | undefined) => (value == null ? undefined : Math.round(value));
const keep = (value: number | null | undefined) => value ?? undefined;

// Missing values stay undefined, so they never overwrite a stored value (ADR-009 upsert).
// Intervals.icu doesn't provide sleep stages, so deep/REM minutes stay empty.
export function healthUpdateFromWellness(record: Wellness): HealthMetricsUpdate {
  return {
    date: record.id,
    source: INTERVALS_SOURCE,
    values: {
      sleepDurationMinutes:
        record.sleepSecs == null ? undefined : Math.round(record.sleepSecs / 60),
      sleepQualityScore: keep(record.sleepScore),
      hrvMs: keep(record.hrv),
      restingHr: round(record.restingHR),
      stressAvg: round(record.stress),
      bodyBattery: bodyBattery(record),
      weightKg: keep(record.weight),
      bodyFatPct: keep(record.bodyFat),
      // ADR-016: load metrics, from the same record.
      ctl: keep(record.ctl),
      atl: keep(record.atl),
      rampRate: keep(record.rampRate),
    },
    raw: record,
  };
}

// A record where nothing we store is set.
export function hasHealthValues(update: HealthMetricsUpdate): boolean {
  return Object.values(update.values).some((value) => value !== undefined);
}

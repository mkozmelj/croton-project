import type { SessionType } from "./session-types.js";

// ADR-021's "progress shown" column: the one number per session type that the dashboard
// charts over time. v1 reads it from the whole activity; the main set from the laps comes later.

export type ProgressMetric = "pace" | "swim_pace" | "power" | "duration" | "rpe";

export type ProgressSpec = {
  metric: ProgressMetric;
  // ADR-021's wording, e.g. "pace at HR".
  label: string;
};

// What a progress number is read from: the activity's numbers and the athlete's RPE.
export type ProgressSource = {
  sport: string;
  durationSeconds: number;
  distanceMeters: number | null;
  avgPacePerKm: number | null;
  avgPower: number | null;
  rpe: number | null;
};

const spec = (metric: ProgressMetric, label: string): ProgressSpec => ({ metric, label });

const BY_TYPE: Partial<Record<SessionType, ProgressSpec>> = {
  run_recovery: spec("pace", "pace, HR"),
  run_easy: spec("pace", "pace at HR"),
  run_long: spec("duration", "duration, pace at HR"),
  run_long_quality: spec("pace", "pace, HR"),
  run_tempo: spec("pace", "pace at HR"),
  run_threshold: spec("pace", "pace, HR"),
  run_vo2: spec("pace", "pace, HR"),
  run_speed: spec("pace", "pace"),
  run_hills: spec("pace", "pace, HR"),
  run_race_pace: spec("pace", "pace at HR"),
  bike_recovery: spec("power", "power, HR"),
  bike_endurance: spec("power", "power at HR"),
  bike_long: spec("duration", "duration, power at HR"),
  bike_tempo: spec("power", "power at HR"),
  bike_sweet_spot: spec("power", "power, HR"),
  bike_threshold: spec("power", "power, HR"),
  bike_vo2: spec("power", "power"),
  bike_sprint: spec("power", "power"),
  bike_force: spec("power", "power, cadence"),
  bike_race_pace: spec("power", "power at HR"),
  swim_technique: spec("swim_pace", "pace / 100 m"),
  swim_endurance: spec("swim_pace", "pace / 100 m"),
  swim_css: spec("swim_pace", "pace / 100 m"),
  swim_speed: spec("swim_pace", "pace / 100 m"),
  swim_open_water: spec("swim_pace", "pace / 100 m"),
  strength_full_body: spec("rpe", "RPE, feel"),
  strength_lower: spec("rpe", "RPE, feel"),
  strength_upper_core: spec("rpe", "RPE, feel"),
  strength_power: spec("rpe", "RPE, feel"),
  tennis: spec("rpe", "RPE, duration"),
  mobility: spec("duration", "duration"),
  race: spec("duration", "result"),
};

// Bricks, field tests and fallback types depend on the session's sport: a brick's run leg
// shows run pace, its bike leg power.
function bySport(sport: string, label: string): ProgressSpec {
  switch (sport) {
    case "run":
    case "trail_run":
      return spec("pace", label);
    case "bike":
      return spec("power", label);
    case "swim":
      return spec("swim_pace", label);
    default:
      return spec("duration", label);
  }
}

export function progressSpec(type: SessionType, sport: string): ProgressSpec {
  const known = BY_TYPE[type];
  if (known) return known;
  if (type === "brick_aerobic") return bySport(sport, "run pace at HR");
  if (type === "brick_race_pace") return bySport(sport, "power, run pace");
  if (type === "field_test") return bySport(sport, "the marker");
  return bySport(sport, "duration");
}

// Lower is better for paces; the chart turns its axis over for them.
export const lowerIsBetter = (metric: ProgressMetric) =>
  metric === "pace" || metric === "swim_pace";

const RUN_SPORTS = new Set(["run", "trail_run"]);

// The progress number of one session, or null when the activity doesn't have it (a run
// without distance, a ride without a power meter, strength without an RPE answer).
export function progressValue(metric: ProgressMetric, source: ProgressSource): number | null {
  const km = (source.distanceMeters ?? 0) / 1000;
  switch (metric) {
    case "pace":
      if (source.avgPacePerKm) return source.avgPacePerKm;
      return RUN_SPORTS.has(source.sport) && km > 0 ? source.durationSeconds / km : null;
    case "swim_pace":
      return km > 0 ? source.durationSeconds / (km * 10) : null;
    case "power":
      return source.avgPower ?? null;
    case "duration":
      return source.durationSeconds > 0 ? source.durationSeconds / 60 : null;
    case "rpe":
      return source.rpe;
  }
}

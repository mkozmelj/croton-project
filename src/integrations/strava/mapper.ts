import type { NewActivity } from "../../db/activities.js";
import type { StravaActivity } from "./client.js";

// Strava `sport_type` → the app's sport names. Unlisted types become
// snake_case of the Strava name, so nothing is dropped.
const SPORTS: Record<string, string> = {
  Run: "run",
  VirtualRun: "run",
  TrailRun: "trail_run",
  Ride: "bike",
  VirtualRide: "bike",
  GravelRide: "bike",
  MountainBikeRide: "bike",
  EBikeRide: "bike",
  EMountainBikeRide: "bike",
  Swim: "swim",
  Tennis: "tennis",
  WeightTraining: "strength",
  Crossfit: "strength",
  Workout: "strength",
  Hike: "hike",
  Walk: "walk",
};

const PACE_SPORTS = new Set(["run", "trail_run", "hike", "walk"]);

export function sportFromStrava(sportType: string): string {
  return SPORTS[sportType] ?? sportType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const round = (value: number) => Math.round(value);

export function activityFromStrava({ activity, raw }: { activity: StravaActivity; raw: unknown }) {
  const sport = sportFromStrava(activity.sport_type);
  const distance = activity.distance ?? null;
  const pace =
    PACE_SPORTS.has(sport) && distance && distance > 0
      ? Math.round((activity.moving_time / (distance / 1000)) * 10) / 10
      : null;

  const row: NewActivity = {
    externalId: String(activity.id),
    source: "strava",
    sport,
    name: activity.name ?? null,
    startedAt: new Date(activity.start_date),
    durationSeconds: activity.moving_time,
    elapsedSeconds: activity.elapsed_time ?? null,
    distanceMeters: distance,
    elevationGainMeters: activity.total_elevation_gain ?? null,
    avgHr: activity.average_heartrate != null ? round(activity.average_heartrate) : null,
    maxHr: activity.max_heartrate != null ? round(activity.max_heartrate) : null,
    avgPacePerKm: pace,
    avgPower: activity.weighted_average_watts ?? activity.average_watts ?? null,
    // Strava's Relative Effort — the closest thing to a load score without power/HR models.
    trainingLoad: activity.suffer_score ?? null,
    zoneDistribution: null,
    laps:
      activity.laps && activity.laps.length > 1
        ? activity.laps.map((lap, index) => ({
            name: lap.name ?? `Lap ${index + 1}`,
            elapsedSeconds: lap.elapsed_time,
            movingSeconds: lap.moving_time,
            distanceMeters: lap.distance,
            avgHr: lap.average_heartrate != null ? round(lap.average_heartrate) : null,
            avgWatts: lap.average_watts ?? null,
          }))
        : null,
    notes: activity.description || null,
    rawData: raw,
  };
  return row;
}

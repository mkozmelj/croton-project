import type { Activity } from "../../db/activities.js";
import type { OAuthTokenSet, OAuthTokenStore } from "../../db/oauth-tokens.js";
import type { StravaActivity } from "./client.js";

// Obviously fake data only (ADR-013).
export function stravaActivity(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 111,
    athlete: { id: 4242 },
    name: "Test Tempo",
    sport_type: "Run",
    start_date: "2026-09-22T05:00:00Z",
    moving_time: 2556,
    elapsed_time: 2600,
    distance: 8100,
    total_elevation_gain: 45,
    average_heartrate: 157.6,
    max_heartrate: 171,
    average_watts: null,
    weighted_average_watts: null,
    suffer_score: 60,
    description: "",
    laps: null,
    ...overrides,
  };
}

export function storedActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 1,
    externalId: "111",
    source: "strava",
    sport: "run",
    name: "Test Tempo",
    startedAt: new Date("2026-09-22T05:00:00Z"),
    durationSeconds: 2556,
    elapsedSeconds: 2600,
    distanceMeters: 8100,
    elevationGainMeters: 45,
    avgHr: 158,
    maxHr: 171,
    avgPacePerKm: 315.6,
    avgPower: null,
    trainingLoad: 60,
    zoneDistribution: null,
    laps: null,
    notes: null,
    rawData: {},
    createdAt: new Date("2026-09-22T06:00:00Z"),
    updatedAt: new Date("2026-09-22T06:00:00Z"),
    ...overrides,
  };
}

export function inMemoryTokens(initial?: OAuthTokenSet) {
  let stored: OAuthTokenSet | null = initial ?? null;
  const saves: OAuthTokenSet[] = [];
  const store: OAuthTokenStore = {
    async get() {
      return stored;
    },
    async save(_provider, tokens) {
      stored = tokens;
      saves.push(tokens);
    },
    async remove() {
      stored = null;
    },
  };
  return { store, saves, current: () => stored };
}

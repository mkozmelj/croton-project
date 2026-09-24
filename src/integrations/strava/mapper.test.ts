import { describe, expect, it } from "vitest";
import { activityFromStrava, sportFromStrava } from "./mapper.js";
import { stravaActivity } from "./test-fixtures.js";

describe("sportFromStrava", () => {
  it.each([
    ["Run", "run"],
    ["TrailRun", "trail_run"],
    ["GravelRide", "bike"],
    ["VirtualRide", "bike"],
    ["WeightTraining", "strength"],
    ["Tennis", "tennis"],
    ["StandUpPaddling", "stand_up_paddling"],
  ])("maps %s to %s", (sportType, sport) => {
    expect(sportFromStrava(sportType)).toBe(sport);
  });
});

describe("activityFromStrava", () => {
  it("maps a run, keyed by the Strava id, with pace per km", () => {
    const activity = stravaActivity();
    const row = activityFromStrava({ activity, raw: { id: 111 } });
    expect(row).toMatchObject({
      externalId: "111",
      source: "strava",
      sport: "run",
      startedAt: new Date("2026-09-22T05:00:00Z"),
      durationSeconds: 2556,
      distanceMeters: 8100,
      avgHr: 158,
      maxHr: 171,
      avgPacePerKm: 315.6,
      trainingLoad: 60,
      notes: null,
      rawData: { id: 111 },
    });
  });

  it("gives rides power instead of pace, preferring weighted power", () => {
    const row = activityFromStrava({
      activity: stravaActivity({
        sport_type: "Ride",
        average_watts: 180,
        weighted_average_watts: 195,
      }),
      raw: {},
    });
    expect(row.avgPacePerKm).toBeNull();
    expect(row.avgPower).toBe(195);
  });

  it("keeps laps only when there is more than one", () => {
    const lap = { name: "Lap 1", elapsed_time: 300, moving_time: 295, distance: 1000 };
    expect(
      activityFromStrava({ activity: stravaActivity({ laps: [lap] }), raw: {} }).laps,
    ).toBeNull();
    const laps = activityFromStrava({
      activity: stravaActivity({ laps: [lap, { ...lap, name: null, average_heartrate: 160.4 }] }),
      raw: {},
    }).laps;
    expect(laps?.[1]).toEqual({
      name: "Lap 2",
      elapsedSeconds: 300,
      movingSeconds: 295,
      distanceMeters: 1000,
      avgHr: 160,
      avgWatts: null,
    });
  });
});

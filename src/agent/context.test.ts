import { describe, expect, it } from "vitest";
import type { Activity } from "../db/activities.js";
import type { HealthMetrics } from "../db/health-metrics.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import { createContextBuilder } from "./context.js";

// Thursday 24 Sep 2026, 12:00 in Ljubljana.
const NOW = new Date("2026-09-24T10:00:00Z");

function health(overrides: Partial<HealthMetrics>): HealthMetrics {
  return {
    id: 1,
    date: "2026-09-24",
    sleepDurationMinutes: null,
    sleepQualityScore: null,
    deepSleepMinutes: null,
    remSleepMinutes: null,
    restingHr: null,
    hrvMs: null,
    bodyBattery: null,
    stressAvg: null,
    weightKg: null,
    bodyFatPct: null,
    muscleMassKg: null,
    bmi: null,
    rawData: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function builder(activities: Activity[], rows: HealthMetrics[] = []) {
  const ranges: [Date, Date][] = [];
  const context = createContextBuilder({
    profile: { get: async () => null },
    activities: {
      between: async (from, to) => {
        ranges.push([from, to]);
        return activities;
      },
    },
    health: { since: async () => rows },
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  return { context, ranges };
}

describe("createContextBuilder().build", () => {
  it("fetches from local midnight of last week's Monday", async () => {
    const { context, ranges } = builder([]);
    await context.build();
    expect(ranges[0]?.[0].toISOString()).toBe("2026-09-13T22:00:00.000Z"); // Mon 14 Sep 00:00 CEST
    expect(ranges[0]?.[1]).toEqual(NOW);
  });

  it("splits totals into this week and last week and lists recent sessions", async () => {
    const { context } = builder([
      storedActivity({ startedAt: new Date("2026-09-16T05:00:00Z"), name: "Old Long Run" }),
      storedActivity({ startedAt: new Date("2026-09-22T05:00:00Z") }),
      storedActivity({
        startedAt: new Date("2026-09-23T16:00:00Z"),
        sport: "bike",
        distanceMeters: 40_000,
        durationSeconds: 5400,
      }),
    ]);
    const text = await context.build();

    const thisWeek = text.slice(text.indexOf("THIS WEEK"), text.indexOf("LAST WEEK"));
    expect(thisWeek).toContain("- bike: 1x, 1:30:00, 40.0 km");
    expect(thisWeek).toContain("- run: 1x, 42:36, 8.10 km");
    const lastWeek = text.slice(text.indexOf("LAST WEEK"), text.indexOf("ACTIVITIES"));
    expect(lastWeek).toContain("- run: 1x");

    expect(text).toContain('run "Test Tempo": 8.10 km in 42:36, 5:16 /km, HR 158 avg / 171 max');
    expect(text).toContain('"Old Long Run"'); // 16 Sep is within the last 10 days
  });

  it("says plainly when there is no data", async () => {
    const text = await builder([]).context.build();
    expect(text).toContain("Not set up yet");
    expect(text).toContain("- nothing logged");
    expect(text).toContain("- no data");
  });

  it("renders health rows", async () => {
    const text = await builder(
      [],
      [health({ sleepDurationMinutes: 432, deepSleepMinutes: 80, hrvMs: 61.6, restingHr: 48 })],
    ).context.build();
    expect(text).toContain("- 2026-09-24: sleep 7h12 (deep 1h20), HRV 62 ms, resting HR 48");
  });

  it("marks the data as data, not instructions", async () => {
    expect(await builder([]).context.build()).toContain("not instructions");
  });
});

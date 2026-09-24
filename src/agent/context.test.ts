import { describe, expect, it } from "vitest";
import type { Activity } from "../db/activities.js";
import type { StoredMarker } from "../db/fitness-markers.js";
import type { GoalWithEvent } from "../db/goals.js";
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
    ctl: null,
    atl: null,
    rampRate: null,
    rawData: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function marker(overrides: Partial<StoredMarker>): StoredMarker {
  return {
    id: 1,
    sport: "bike",
    metric: "ftp_w",
    value: 250,
    measuredOn: "2026-09-03",
    source: "intervals",
    sourceRef: null,
    notes: null,
    createdAt: NOW,
    ...overrides,
  };
}

function goal(priority: "A" | "B" | "C", name: string, date: string): GoalWithEvent {
  return {
    id: 1,
    eventId: 1,
    season: Number(date.slice(0, 4)),
    priority,
    goalType: "time",
    target: "4:45:00",
    targetSeconds: 17_100,
    notes: null,
    status: "active",
    result: null,
    createdAt: NOW,
    updatedAt: NOW,
    event: {
      id: 1,
      name,
      date,
      sport: "triathlon",
      distance: "70.3",
      location: null,
      calendarEventId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

type Extras = { markers?: StoredMarker[]; goals?: GoalWithEvent[] };

function builder(activities: Activity[], rows: HealthMetrics[] = [], extras: Extras = {}) {
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
    fitness: { latest: async () => extras.markers ?? [] },
    goals: { activeInSeasons: async () => extras.goals ?? [] },
    plans: { forWeek: async () => null },
    pending: { live: async () => [] },
    chatId: 1,
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  return { context, ranges };
}

describe("createContextBuilder().build", () => {
  it("fetches six weeks back from this week's Monday", async () => {
    const { context, ranges } = builder([]);
    await context.build();
    expect(ranges[0]?.[0].toISOString()).toBe("2026-08-09T22:00:00.000Z"); // Mon 10 Aug 00:00 CEST
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

  it("lists markers with age and source, and flags stale ones", async () => {
    const text = await builder([], [], {
      markers: [
        marker({}),
        marker({
          sport: "run",
          metric: "vdot",
          value: 48.2,
          measuredOn: "2026-05-01",
          source: "race",
        }),
      ],
    }).context.build();
    expect(text).toContain("- bike: FTP 250 W, from Intervals.icu, 3 weeks ago (2026-09-03)\n");
    expect(text).toContain("- run: VDOT 48.2, from a race, 5 months ago (2026-05-01), STALE");
  });

  it("tells the agent to use RPE and schedule a test for a sport without an anchor", async () => {
    const text = await builder([storedActivity({ sport: "swim" })]).context.build();
    expect(text).toContain(
      "- swim: NO INTENSITY ANCHOR. Prescribe swim intensity by RPE and schedule a CSS test",
    );
  });

  it("derives the phase from the A goal and lists near B/C events", async () => {
    const text = await builder([], [], {
      goals: [goal("A", "Test 70.3", "2027-06-13"), goal("B", "Test Half", "2026-11-15")],
    }).context.build();
    expect(text).toContain(
      '- A: "Test 70.3" (triathlon, 70.3) on 2027-06-13, 37 weeks (262 days) away',
    );
    expect(text).toContain("- Current phase (derived from the A event date): base");
    expect(text).toContain('- B: "Test Half"');
  });

  it("adds six weeks of totals and the load trend for plan generation", async () => {
    const text = await builder(
      [storedActivity({ startedAt: new Date("2026-08-12T05:00:00Z") })],
      [health({ date: "2026-09-20", ctl: 40, atl: 50, rampRate: 2 })],
    ).context.build({ detail: "baseline", planWeek: "2026-09-28" });
    expect(text).toContain("LAST 6 WEEKS, per-sport totals");
    expect(text).toContain("- Mon 2026-08-10: run: 1x");
    expect(text).toContain("CTL 40.0, ATL 50.0, ramp rate 2.0, ACWR (ATL/CTL) 1.25");
    expect(text).toContain("- Planned week (Mon 2026-09-28): phase unknown (no A goal).");
  });

  it("marks the data as data, not instructions", async () => {
    expect(await builder([]).context.build()).toContain("not instructions");
  });
});

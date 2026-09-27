import { describe, expect, it } from "vitest";
import type { StoredMarker } from "../db/fitness-markers.js";
import type { StoredPlan } from "../db/training-plans.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import type { WeekPlan } from "../training/plan.js";
import { addMarkerPayload } from "./actions.js";
import { createMarkerProposer } from "./marker-proposals.js";
import { inMemoryPending } from "./test-helpers.js";

const NOW = new Date("2026-09-26T12:00:00Z");

const FTP: StoredMarker = {
  id: 1,
  sport: "bike",
  metric: "ftp_w",
  value: 250,
  measuredOn: "2026-08-01",
  source: "intervals",
  sourceRef: null,
  notes: null,
  createdAt: NOW,
};

// Friday 2026-09-25, a 20-min lap at 290 W: a field test's numbers, and a breakthrough's.
const testRide = storedActivity({
  externalId: "777",
  sport: "bike",
  name: "FTP test",
  startedAt: new Date("2026-09-25T15:00:00Z"),
  durationSeconds: 3600,
  distanceMeters: 30_000,
  laps: [
    {
      name: "Lap 2",
      elapsedSeconds: 1200,
      movingSeconds: 1200,
      distanceMeters: 12_000,
      avgHr: 165,
      avgWatts: 290,
    },
  ],
  rawData: { average_watts: 210, device_watts: true },
});

function planWithTest(fieldTest: WeekPlan["workouts"][number]["field_test"]): StoredPlan {
  return {
    plan: {
      week_start: "2026-09-21",
      phase: "base",
      focus: "f",
      workouts: [
        {
          date: "2026-09-25",
          start_time: "17:00",
          sport: "bike",
          title: "FTP test",
          duration_minutes: 60,
          intensity: "hard",
          structure: [{ segment: "main", description: "20 min all out" }],
          targets: null,
          field_test: fieldTest,
          notes: null,
        },
      ],
      weekly_targets: null,
    },
  } as unknown as StoredPlan;
}

function setup(plan: StoredPlan | null) {
  const pending = inMemoryPending(() => NOW);
  const proposer = createMarkerProposer({
    plans: { forWeek: async () => plan },
    pending: pending.store,
    fitness: { latest: async () => [FTP] },
    chatId: 7,
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  return { proposer };
}

const sources = (payload: unknown) =>
  addMarkerPayload.parse(payload).markers.map((m) => `${m.metric}:${m.source}`);

describe("createMarkerProposer", () => {
  it("proposes the field-test markers for a planned test, and no breakthrough", async () => {
    const { proposer } = setup(planWithTest("bike_ftp_20min"));
    const proposals = await proposer.propose(testRide);
    expect(proposals).toHaveLength(1);
    expect(sources(proposals[0]?.payload)).toEqual(["ftp_w:field_test", "lthr_bpm:field_test"]);
  });

  it("proposes a breakthrough when the hard ride wasn't a planned test", async () => {
    const { proposer } = setup(planWithTest(null));
    const [proposal] = await proposer.propose(testRide);
    expect(proposal?.actionType).toBe("add_fitness_marker");
    expect(sources(proposal?.payload)).toEqual(["ftp_w:activity"]);
    expect(addMarkerPayload.parse(proposal?.payload).markers[0]?.value).toBe(276);
  });

  it("proposes nothing for estimated power or an ordinary ride", async () => {
    const { proposer } = setup(null);
    expect(
      await proposer.propose({ ...testRide, rawData: { average_watts: 210, device_watts: false } }),
    ).toEqual([]);
    expect(await proposer.propose({ ...testRide, laps: null })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Workout } from "../../training/plan.js";
import { PLAN_BLOCK_START, planBlock, withPlanBlock } from "./plan-description.js";

const tempo: Workout = {
  date: "2026-09-22",
  start_time: "07:00",
  sport: "run",
  title: "Tempo intervals",
  duration_minutes: 60,
  intensity: "hard",
  structure: [
    { segment: "warmup", description: "15 min Z1-2" },
    { segment: "main", description: "3x8 min Z4, 3 min jog between" },
    { segment: "cooldown", description: "10 min Z1" },
  ],
  targets: "4:05-4:15 /km",
  field_test: null,
  notes: "Private coaching note",
};

const run = {
  durationSeconds: 58 * 60,
  distanceMeters: 12_000,
  avgHr: 152,
  avgPacePerKm: 252,
  avgPower: null,
};

describe("planBlock", () => {
  it("is a short actual-versus-plan summary without emojis", () => {
    const block = planBlock({ workout: tempo, activity: run });
    expect(block).toBe(
      [
        "Plan: Tempo intervals (hard)",
        "Duration: 58 / 60 min",
        "Distance: 12.0 km",
        "Avg pace: 4:12 /km",
        "Avg HR: 152 bpm",
        "Target: 4:05-4:15 /km",
        "Main set: 3x8 min Z4, 3 min jog between",
      ].join("\n"),
    );
    // The workout's notes can mention recovery data; the description is often public.
    expect(block).not.toContain("Private");
  });

  it("names a field test and leaves out the plan share for a brick", () => {
    const test = { ...tempo, field_test: "run_lthr_30min" as const };
    expect(planBlock({ workout: test, activity: run })).toContain("Test: 30-min run LTHR test");
    const brick = { ...tempo, sport: "brick" as const };
    expect(planBlock({ workout: brick, activity: run })).toContain("Duration: 58 min\n");
  });
});

describe("withPlanBlock", () => {
  const block = `${PLAN_BLOCK_START} Tempo`;

  it("keeps the athlete's own text first", () => {
    expect(withPlanBlock(null, block)).toBe(block);
    expect(withPlanBlock("Windy.  ", block)).toBe(`Windy.\n\n${block}`);
  });

  it("replaces an earlier block instead of adding a second one", () => {
    const before = withPlanBlock("Windy.", `${PLAN_BLOCK_START} Old\nDuration: 1 / 2 min`);
    expect(withPlanBlock(before, block)).toBe(`Windy.\n\n${block}`);
  });

  it("replaces a block from the first version", () => {
    const legacy = "Windy.\n\n\u{1F4CB} Planned: Old\n\u2014 Croton coach";
    expect(withPlanBlock(legacy, block)).toBe(`Windy.\n\n${block}`);
  });
});

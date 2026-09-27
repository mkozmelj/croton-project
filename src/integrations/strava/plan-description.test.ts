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
const easy: Workout = { ...tempo, date: "2026-09-21", title: "Easy run", intensity: "easy" };

describe("planBlock", () => {
  it("lists the plan, the targets, how much was done and where the week stands", () => {
    const block = planBlock({
      workout: tempo,
      plan: { phase: "build", workouts: [easy, tempo] },
      movingSeconds: 58 * 60,
    });
    expect(block).toBe(
      [
        "📋 Planned: Tempo intervals · 60 min · hard",
        "Warm-up: 15 min Z1-2",
        "Main: 3x8 min Z4, 3 min jog between",
        "Cool-down: 10 min Z1",
        "🎯 Targets: 4:05-4:15 /km",
        "✅ Done: 58 of 60 min (97%)",
        "📆 Session 2 of 2 this week · Build phase",
        "— Croton coach",
      ].join("\n"),
    );
    // The workout's notes can mention recovery data; the description is often public.
    expect(block).not.toContain("Private");
  });

  it("names a field test and leaves out the done share for a brick", () => {
    const test = { ...tempo, field_test: "run_lthr_30min" as const };
    expect(
      planBlock({ workout: test, plan: { phase: null, workouts: [test] }, movingSeconds: 1 }),
    ).toContain("🧪 30-min run LTHR test");
    const brick = { ...tempo, sport: "brick" as const };
    expect(
      planBlock({ workout: brick, plan: { phase: null, workouts: [brick] }, movingSeconds: 60 }),
    ).not.toContain("Done:");
  });
});

describe("withPlanBlock", () => {
  const block = `${PLAN_BLOCK_START} Tempo`;

  it("keeps the athlete's own text first", () => {
    expect(withPlanBlock(null, block)).toBe(block);
    expect(withPlanBlock("Windy.  ", block)).toBe(`Windy.\n\n${block}`);
  });

  it("replaces an earlier block instead of adding a second one", () => {
    const before = withPlanBlock("Windy.", `${PLAN_BLOCK_START} Old\n— Croton coach`);
    expect(withPlanBlock(before, block)).toBe(`Windy.\n\n${block}`);
  });
});

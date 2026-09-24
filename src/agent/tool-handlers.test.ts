import { describe, expect, it } from "vitest";
import type { GoalWithEvent } from "../db/goals.js";
import { inMemoryPending } from "./test-helpers.js";
import { createToolHandlers, parseClock, raceMarkersFrom } from "./tool-handlers.js";

const NOW = new Date("2026-09-24T10:00:00Z");
const context = { chatId: 1, now: NOW, today: "2026-09-24" };

const existingA = {
  id: 9,
  priority: "A",
  event: { name: "Old A", date: "2027-05-01" },
} as GoalWithEvent;

function setup(goals: GoalWithEvent[] = []) {
  const pending = inMemoryPending(() => NOW);
  const handlers = createToolHandlers({
    pending: pending.store,
    goals: { activeInSeasons: async () => goals },
    plans: { forWeek: async () => null },
  });
  return { handlers, pending };
}

const goalInput = {
  event_name: "Test 70.3",
  event_date: "2027-06-13",
  sport: "triathlon",
  distance: "70.3",
  location: null,
  priority: "A",
  goal_type: "time",
  target: "4:45:00",
  notes: null,
  replace_existing_a_goal: false,
};

describe("propose_goal", () => {
  it("creates a set_goal proposal with the season and parsed target", async () => {
    const { handlers, pending } = setup();
    const outcome = await handlers.run({ name: "propose_goal", input: goalInput }, context);
    expect(outcome.isError).toBe(false);
    expect(outcome.proposal?.actionType).toBe("set_goal");
    expect(pending.rows()[0]?.payload).toMatchObject({
      goal: { season: 2027, priority: "A", targetSeconds: 17_100 },
      replaceGoal: null,
    });
  });

  it("refuses a second A goal and asks about replacing it", async () => {
    const { handlers, pending } = setup([existingA]);
    const outcome = await handlers.run({ name: "propose_goal", input: goalInput }, context);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("already has an active A goal: Old A");
    expect(pending.rows()).toHaveLength(0);
  });

  it("proposes the replacement once the athlete agreed", async () => {
    const { handlers, pending } = setup([existingA]);
    await handlers.run(
      { name: "propose_goal", input: { ...goalInput, replace_existing_a_goal: true } },
      context,
    );
    expect(pending.rows()[0]?.payload).toMatchObject({ replaceGoal: { id: 9, name: "Old A" } });
  });

  it("rejects past events and malformed input", async () => {
    const { handlers } = setup();
    expect(
      (
        await handlers.run(
          { name: "propose_goal", input: { ...goalInput, event_date: "2026-01-01" } },
          context,
        )
      ).isError,
    ).toBe(true);
    const bad = await handlers.run({ name: "propose_goal", input: { event_name: 3 } }, context);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("Invalid input");
  });
});

describe("propose_fitness_marker", () => {
  const input = {
    sport: "run",
    metric: "vdot",
    value: null,
    race: { distance_meters: 5000, time_seconds: 1197 }, // 19:57
    measured_on: "2026-05-10",
    source: "race",
    notes: null,
  };

  it("computes a race VDOT in code", async () => {
    const { handlers, pending } = setup();
    const outcome = await handlers.run({ name: "propose_fitness_marker", input }, context);
    expect(outcome.content).toMatch(/^VDOT 50\.0\./);
    expect(pending.rows()[0]?.payload).toMatchObject({
      markers: [{ sport: "run", metric: "vdot", value: 50, source: "race" }],
    });
  });

  it("rejects a metric that doesn't fit the sport", async () => {
    const { handlers } = setup();
    const outcome = await handlers.run(
      { name: "propose_fitness_marker", input: { ...input, sport: "bike", race: null, value: 50 } },
      context,
    );
    expect(outcome.isError).toBe(true);
  });
});

describe("propose_week_plan", () => {
  const plan = {
    week_start: "2026-09-28",
    phase: "base",
    focus: "Aerobic base",
    workouts: [
      {
        date: "2026-09-29",
        start_time: "07:00",
        sport: "run",
        title: "Easy run",
        duration_minutes: 45,
        intensity: "easy",
        structure: [{ segment: "main", description: "45 min Z2" }],
        targets: null,
        field_test: null,
        notes: null,
      },
    ],
    weekly_targets: { total_hours: 5, run_km: 30, bike_km: null, swim_km: null, easy_percent: 85 },
    reason: "Moved the long run",
  };

  it("accepts next week's plan and supersedes an older proposal", async () => {
    const { handlers, pending } = setup();
    await handlers.run({ name: "propose_week_plan", input: plan }, context);
    await handlers.run({ name: "propose_week_plan", input: plan }, context);
    expect(pending.rows().filter((r) => r.actionType === "apply_plan")).toHaveLength(1);
  });

  it("refuses other weeks and invalid sessions", async () => {
    const { handlers } = setup();
    const farWeek = await handlers.run(
      { name: "propose_week_plan", input: { ...plan, week_start: "2026-10-12" } },
      context,
    );
    expect(farWeek.isError).toBe(true);
    const badTime = await handlers.run(
      {
        name: "propose_week_plan",
        input: { ...plan, workouts: [{ ...plan.workouts[0], start_time: "7am" }] },
      },
      context,
    );
    expect(badTime.content).toContain("start_time must be HH:MM");
  });
});

describe("helpers", () => {
  it("parses clock targets", () => {
    expect(parseClock("4:45:00")).toBe(17_100);
    expect(parseClock("45:30")).toBe(2730);
    expect(parseClock("top 10")).toBeNull();
  });

  it("turns flat running results into VDOT markers only", () => {
    const markers = raceMarkersFrom({
      years_by_sport: [],
      typical_weekly_hours: null,
      notes: null,
      recent_results: [
        {
          date: "2026-04-12",
          event: "City 10K",
          sport: "run",
          distance_meters: 10_000,
          time_seconds: 2481,
          notes: null,
        },
        {
          date: "2026-06-01",
          event: "Trail 30K",
          sport: "trail_run",
          distance_meters: 30_000,
          time_seconds: 12_000,
          notes: null,
        },
      ],
    });
    expect(markers).toEqual([
      expect.objectContaining({
        metric: "vdot",
        value: 50,
        measuredOn: "2026-04-12",
        source: "race",
        notes: "City 10K",
      }),
    ]);
  });
});

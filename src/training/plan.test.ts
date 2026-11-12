import { describe, expect, it } from "vitest";
import { parseWeekPlan } from "./plan.js";

const stored = (workout: Record<string, unknown>) => ({
  week_start: "2026-11-09",
  phase: "base",
  focus: "f",
  workouts: [
    {
      date: "2026-11-12",
      start_time: "06:30",
      sport: "swim",
      title: "Easy technique swim",
      duration_minutes: 40,
      intensity: "easy",
      structure: [],
      targets: null,
      field_test: null,
      notes: null,
      ...workout,
    },
  ],
  weekly_targets: { total_hours: 1, run_km: null, bike_km: null, swim_km: 1.4, easy_percent: 90 },
});

describe("parseWeekPlan", () => {
  it("reads plans stored before watch steps existed", () => {
    expect(parseWeekPlan(stored({}))?.workouts[0]?.steps).toBeNull();
  });

  it("reads steps stored before step intensity existed, as work", () => {
    const plan = parseWeekPlan(
      stored({
        steps: [
          {
            repeat: 6,
            steps: [{ label: "Rest", duration_seconds: 20, distance_meters: null, target: null }],
          },
        ],
      }),
    );
    expect(plan?.workouts[0]?.steps?.[0]?.steps[0]?.intensity).toBe("active");
  });
});

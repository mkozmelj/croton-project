import { describe, expect, it } from "vitest";
import {
  activeMinutes,
  completionStatus,
  isRestDayEntry,
  planIssues,
  storedPlanSchema,
  type WeekPlanInput,
  type WorkoutInput,
  withLegacyRests,
  withoutInvalidWorkouts,
} from "./plan.js";

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

const parse = (value: unknown) => storedPlanSchema.safeParse(value).data;

describe("storedPlanSchema", () => {
  it("reads plans stored before watch steps and session types existed", () => {
    const workout = parse(stored({}))?.workouts[0];
    expect(workout?.steps).toBeNull();
    expect(workout?.session_type).toBe("other");
    expect(workout?.brick_with_previous).toBe(false);
  });

  it("reads steps stored before step intensity existed, as work", () => {
    const plan = parse(
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

  it("turns the timed 'Rest' steps of a legacy plan into rests", () => {
    const step = (label: string, distance: number | null, seconds: number | null) => ({
      label,
      duration_seconds: seconds,
      distance_meters: distance,
      target: null,
      intensity: "active" as const,
    });
    const workout = parse(
      stored({
        sport: "swim",
        duration_minutes: 40,
        steps: [
          { repeat: 1, steps: [step("Warm-up", 300, null)] },
          { repeat: 6, steps: [step("Z2 100 m", 100, null), step("Rest", null, 20)] },
          { repeat: 1, steps: [step("Restful easy", 200, null), step("Resting HR", null, 60)] },
        ],
      }),
    )?.workouts[0];
    if (!workout) throw new Error("plan didn't parse");
    expect(activeMinutes(workout)).toBe(40);
    const fixed = withLegacyRests(workout);
    expect(fixed.steps?.flatMap((b) => b.steps.map((s) => s.intensity))).toEqual([
      "active",
      "active",
      "rest",
      "active",
      "active",
    ]);
    // 6x20 s of rest come off the 40 minutes.
    expect(activeMinutes(fixed)).toBe(38);
  });

  it("recognises a rest day the first plans wrote as a session", () => {
    expect(isRestDayEntry({ sport: "other", title: "Rest - travel day" })).toBe(true);
    expect(isRestDayEntry({ sport: "other", title: "Restorative yoga" })).toBe(false);
    expect(isRestDayEntry({ sport: "swim", title: "Rest day swim" })).toBe(false);
  });

  it("still reads a single 'brick' session", () => {
    expect(parse(stored({ sport: "brick" }))?.workouts[0]?.sport).toBe("brick");
  });
});

function workout(overrides: Partial<WorkoutInput> = {}): WorkoutInput {
  return {
    date: "2026-11-12",
    start_time: "07:00",
    sport: "run",
    session_type: "run_easy",
    title: "Easy run",
    duration_minutes: 45,
    active_minutes: 45,
    brick_with_previous: false,
    intensity: "easy",
    structure: [],
    steps: null,
    targets: null,
    field_test: null,
    notes: null,
    ...overrides,
  };
}

const rest = (seconds: number) => ({
  label: "Rest",
  duration_seconds: seconds,
  distance_meters: null,
  target: null,
  intensity: "rest" as const,
});
const swimRep = {
  label: "Swim",
  duration_seconds: null,
  distance_meters: 100,
  target: null,
  intensity: "active" as const,
};

describe("activeMinutes", () => {
  it("takes the rest steps off a swim's whole duration, ignoring the model's number", () => {
    const swim = workout({
      sport: "swim",
      duration_minutes: 50,
      active_minutes: 50,
      steps: [{ repeat: 10, steps: [swimRep, rest(30)] }],
    });
    expect(activeMinutes(swim)).toBe(45);
  });

  it("uses the model's number for strength, never more than the whole session", () => {
    expect(activeMinutes(workout({ sport: "strength", active_minutes: 30 }))).toBe(30);
    expect(activeMinutes(workout({ sport: "strength", active_minutes: 90 }))).toBe(45);
  });

  it("is the whole duration for a run without rest steps, and for old sessions", () => {
    expect(activeMinutes(workout({ active_minutes: 30 }))).toBe(45);
    expect(activeMinutes(workout({ sport: "swim", active_minutes: undefined }))).toBe(45);
  });
});

describe("completionStatus", () => {
  it("is done from 80% of the active minutes, partial below", () => {
    const strength = workout({ sport: "strength", duration_minutes: 60, active_minutes: 40 });
    expect(completionStatus(strength, 32 * 60)).toBe("done");
    expect(completionStatus(strength, 31 * 60)).toBe("partial");
    expect(completionStatus(workout(), 120 * 60)).toBe("done");
  });

  it("counts any activity on an old single-brick session as done", () => {
    expect(completionStatus(workout({ sport: "brick", duration_minutes: 120 }), 600)).toBe("done");
  });
});

const week = (workouts: WorkoutInput[]): WeekPlanInput => ({
  week_start: "2026-11-09",
  phase: "base",
  focus: "f",
  workouts: workouts.map((w) => ({
    ...w,
    sport: w.sport === "brick" ? "other" : w.sport,
    active_minutes: w.active_minutes ?? w.duration_minutes,
  })),
  weekly_targets: { total_hours: 3, run_km: null, bike_km: null, swim_km: null, easy_percent: 90 },
});

const bikeLeg = workout({
  sport: "bike",
  session_type: "brick_aerobic",
  title: "Brick bike",
  duration_minutes: 75,
  active_minutes: 75,
});
const runLeg = workout({
  start_time: "08:20",
  session_type: "brick_aerobic",
  title: "Brick run",
  duration_minutes: 20,
  active_minutes: 20,
  brick_with_previous: true,
});

describe("planIssues", () => {
  it("accepts a valid week with a two-leg brick", () => {
    expect(planIssues(week([workout({ date: "2026-11-10" }), runLeg, bikeLeg]))).toEqual([]);
  });

  it("rejects a session type that doesn't fit the sport", () => {
    expect(planIssues(week([workout({ session_type: "bike_vo2" })]))).toEqual([
      "workout 1 (Easy run): session_type bike_vo2 doesn't fit sport run",
    ]);
  });

  it("ties session_type field_test to field_test", () => {
    expect(planIssues(week([workout({ field_test: "run_lthr_30min" })]))).toHaveLength(1);
    expect(
      planIssues(week([workout({ field_test: "run_lthr_30min", session_type: "field_test" })])),
    ).toEqual([]);
  });

  it("rejects active minutes over the whole duration", () => {
    expect(planIssues(week([workout({ active_minutes: 50 })]))).toEqual([
      "workout 1 (Easy run): active_minutes can't exceed duration_minutes",
    ]);
  });

  it("rejects a brick leg without its partner", () => {
    expect(planIssues(week([runLeg]))).toHaveLength(1);
    expect(planIssues(week([bikeLeg]))).toHaveLength(1);
    expect(
      planIssues(week([bikeLeg, { ...runLeg, session_type: "brick_race_pace" }])),
    ).toHaveLength(2);
  });
});

describe("withoutInvalidWorkouts", () => {
  it("drops an invalid session, and the brick leg it leaves alone", () => {
    const badBike = { ...bikeLeg, start_time: "7am" };
    const { plan, dropped } = withoutInvalidWorkouts(week([workout(), badBike, runLeg]));
    expect(plan.workouts.map((w) => w.title)).toEqual(["Easy run"]);
    expect(dropped.some((reason) => reason.includes("start_time"))).toBe(true);
  });
});

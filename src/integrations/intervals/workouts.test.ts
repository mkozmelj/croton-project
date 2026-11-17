import { describe, expect, it } from "vitest";
import type { Step, StepBlock, Workout } from "../../training/plan.js";
import type { SportSettings } from "./client.js";
import {
  distanceText,
  durationText,
  stepIssues,
  stepLabel,
  targetText,
  watchExternalId,
  workoutEvent,
  workoutText,
} from "./workouts.js";

const step = (overrides: Partial<Step>): Step => ({
  label: "Easy",
  duration_seconds: 600,
  distance_meters: null,
  target: null,
  intensity: "active",
  ...overrides,
});

const workout = (steps: StepBlock[] | null, overrides: Partial<Workout> = {}): Workout => ({
  date: "2026-11-17",
  start_time: "07:00",
  sport: "run",
  session_type: "run_threshold",
  brick_with_previous: false,
  title: "Tempo intervals",
  duration_minutes: 55,
  intensity: "hard",
  structure: [],
  steps,
  targets: null,
  field_test: null,
  notes: null,
  ...overrides,
});

const settings: SportSettings[] = [
  { types: ["Run", "TrailRun"], ftp: null, lthr: 170, max_hr: 190, threshold_pace: 3.6 },
  { types: ["Ride"], ftp: 250, lthr: 160, max_hr: 185, threshold_pace: null },
  { types: ["Swim"], ftp: null, lthr: null, max_hr: null, threshold_pace: null },
];

describe("durationText / distanceText", () => {
  it("writes Intervals.icu durations", () => {
    expect(durationText(600)).toBe("10m");
    expect(durationText(90)).toBe("1m30s");
    expect(durationText(20)).toBe("20s");
    expect(durationText(3930)).toBe("1h5m30s");
    expect(durationText(3600)).toBe("1h");
  });

  it("uses mtr for metres (m is minutes) and km for round kilometres", () => {
    expect(distanceText(400)).toBe("400mtr");
    expect(distanceText(1000)).toBe("1km");
    expect(distanceText(1500)).toBe("1.5km");
    expect(distanceText(1250)).toBe("1250mtr");
  });
});

describe("targetText", () => {
  it("writes watts and pace ranges, low to high", () => {
    expect(targetText({ metric: "power", min: 250, max: 235 }, "bike", null)).toBe("235-250w");
    expect(targetText({ metric: "power", min: 130, max: 130 }, "bike", null)).toBe("130w");
    expect(targetText({ metric: "pace", min: 290, max: 300 }, "run", null)).toBe(
      "4:50-5:00/km Pace",
    );
    expect(targetText({ metric: "pace", min: 105, max: 110 }, "swim", null)).toBe(
      "1:45-1:50/100m Pace",
    );
  });

  it("turns bpm into % of LTHR, since Intervals.icu doesn't parse bpm", () => {
    expect(targetText({ metric: "hr", min: 145, max: 153 }, "run", 170)).toBe("85.3-90% LTHR");
  });

  it("drops targets it can't express", () => {
    expect(targetText({ metric: "hr", min: 145, max: 153 }, "run", null)).toBeNull();
    expect(targetText({ metric: "pace", min: 120, max: 130 }, "bike", null)).toBeNull();
  });
});

describe("stepLabel", () => {
  it("keeps words only, so the label can't be read as a duration or target", () => {
    expect(stepLabel("4x1km @ Z4")).toBe("");
    expect(stepLabel("Drill 50m")).toBe("Drill");
    expect(stepLabel("400m test")).toBe("test");
    expect(stepLabel("- Warm-up")).toBe("Warm-up");
    expect(stepLabel("Ogrevanje čez hrib")).toBe("Ogrevanje čez hrib");
  });
});

describe("stepIssues", () => {
  it("accepts well-formed steps", () => {
    expect(stepIssues([{ repeat: 4, steps: [step({})] }])).toEqual([]);
  });

  it("flags missing or doubled amounts, bad repeats and bad targets", () => {
    const issues = stepIssues([
      { repeat: 0, steps: [step({ duration_seconds: null })] },
      { repeat: 1, steps: [step({ distance_meters: 400 })] },
      { repeat: 1, steps: [step({ target: { metric: "power", min: 0, max: 200 } })] },
      { repeat: 2, steps: [] },
    ]);
    expect(issues).toEqual([
      "block 1: repeat must be 1-50",
      "block 1 step 1: no duration or distance",
      "block 3 step 1: target must be positive",
      "block 4: no steps",
    ]);
  });
});

describe("workoutText", () => {
  it("renders warm-up, a repeat block and cool-down in the checked syntax", () => {
    const text = workoutText(
      workout([
        {
          repeat: 1,
          steps: [step({ label: "Warm-up", duration_seconds: 900, intensity: "warmup" })],
        },
        {
          repeat: 4,
          steps: [
            step({
              label: "Tempo",
              duration_seconds: null,
              distance_meters: 1000,
              target: { metric: "pace", min: 290, max: 300 },
            }),
            step({
              label: "Jog",
              duration_seconds: 150,
              target: { metric: "hr", min: 119, max: 136 },
              intensity: "recovery",
            }),
          ],
        },
        {
          repeat: 1,
          steps: [step({ label: "Cool-down", duration_seconds: 600, intensity: "cooldown" })],
        },
      ]),
      170,
    );
    expect(text).toBe(
      [
        "- Warm-up 15m intensity=warmup",
        "",
        "4x",
        "- Tempo 1km 4:50-5:00/km Pace intensity=active",
        "- Jog 2m30s 70-80% LTHR intensity=recovery",
        "",
        "- Cool-down 10m intensity=cooldown",
      ].join("\n"),
    );
  });

  it("uses the distance when a step has both", () => {
    const text = workoutText(
      workout([{ repeat: 1, steps: [step({ duration_seconds: 645, distance_meters: 300 })] }], {
        sport: "swim",
      }),
      null,
    );
    expect(text).toBe("- Easy 300mtr intensity=active");
  });

  it("marks swim rests as rest, untargeted, so Garmin doesn't count them as swims", () => {
    const text = workoutText(
      workout(
        [
          {
            repeat: 1,
            steps: [
              step({
                label: "Warm-up",
                duration_seconds: null,
                distance_meters: 300,
                intensity: "warmup",
              }),
              step({ label: "Rest", duration_seconds: 30, intensity: "rest" }),
            ],
          },
          {
            repeat: 6,
            steps: [
              step({
                label: "CSS 100m",
                duration_seconds: null,
                distance_meters: 100,
                target: { metric: "pace", min: 105, max: 110 },
              }),
              step({
                label: "Rest",
                duration_seconds: 20,
                target: { metric: "pace", min: 200, max: 200 },
                intensity: "rest",
              }),
            ],
          },
        ],
        { sport: "swim" },
      ),
      null,
    );
    expect(text).toBe(
      [
        "- Warm-up 300mtr intensity=warmup",
        "- Rest 30s intensity=rest",
        "",
        "6x",
        "- CSS 100mtr 1:45-1:50/100m Pace intensity=active",
        "- Rest 20s intensity=rest",
      ].join("\n"),
    );
  });

  it("returns null without steps or with invalid ones", () => {
    expect(workoutText(workout(null), 170)).toBeNull();
    expect(workoutText(workout([{ repeat: 1, steps: [] }]), 170)).toBeNull();
  });
});

describe("workoutEvent", () => {
  const steps = [{ repeat: 1, steps: [step({ target: { metric: "hr", min: 136, max: 153 } })] }];

  it("builds a WORKOUT event with the sport's LTHR and a stable external id", () => {
    expect(
      workoutEvent(workout(steps, { sport: "trail_run" }), {
        externalId: watchExternalId("plan-7", 2),
        settings,
      }),
    ).toEqual({
      category: "WORKOUT",
      type: "Run",
      name: "Tempo intervals",
      start_date_local: "2026-11-17T07:00:00",
      description: "- Easy 10m 80-90% LTHR intensity=active",
      moving_time: 3300,
      external_id: "croton:plan-7:2",
    });
  });

  it("uses the bike's own LTHR for rides", () => {
    const event = workoutEvent(workout(steps, { sport: "bike" }), { externalId: "x", settings });
    expect(event?.type).toBe("Ride");
    expect(event?.description).toBe("- Easy 10m 85-95.6% LTHR intensity=active");
  });

  it("skips sports that aren't watch workouts and sessions without steps", () => {
    expect(workoutEvent(workout(steps, { sport: "strength" }), { externalId: "x", settings })).toBe(
      null,
    );
    expect(workoutEvent(workout(steps, { sport: "brick" }), { externalId: "x", settings })).toBe(
      null,
    );
    expect(workoutEvent(workout(null), { externalId: "x", settings })).toBeNull();
  });
});

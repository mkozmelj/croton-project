import { describe, expect, it } from "vitest";
import type { StoredPlan } from "../db/training-plans.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import type { Workout } from "../training/plan.js";
import { createFeedbackRequester, questionsFor, stravaRpe } from "./feedback-questions.js";
import { inMemoryFeedback } from "./test-helpers.js";

// The fixture activity starts Tue 22 Sep 2026, 07:00 in Ljubljana, and lasts 42:36.
const STARTED = new Date("2026-09-22T05:00:00Z");
const SOON = new Date("2026-09-22T06:00:00Z");

function workout(overrides: Partial<Workout>): Workout {
  return {
    date: "2026-09-22",
    start_time: "07:00",
    sport: "run",
    title: "Tempo",
    duration_minutes: 45,
    intensity: "hard",
    structure: [],
    targets: null,
    field_test: null,
    notes: null,
    ...overrides,
  };
}

const base = {
  startedAt: STARTED,
  durationSeconds: 2556,
  planned: undefined,
  markerProposed: false,
  rpeKnown: false,
  now: SOON,
};

describe("questionsFor", () => {
  it("asks only RPE (with a note button) after an unplanned, short session", () => {
    expect(questionsFor(base)).toEqual(["rpe", "note"]);
    expect(questionsFor({ ...base, planned: workout({ intensity: "easy" }) })).toEqual([
      "rpe",
      "note",
    ]);
  });

  it("asks the full set after a planned hard session, a long one, or a test", () => {
    const full = ["rpe", "feel", "pain", "note"];
    expect(questionsFor({ ...base, planned: workout({ intensity: "moderate" }) })).toEqual(full);
    expect(questionsFor({ ...base, durationSeconds: 90 * 60 })).toEqual(full);
    expect(questionsFor({ ...base, markerProposed: true })).toEqual(full);
  });

  it("leaves out RPE when Strava already has it, and asks nothing if only a note is left", () => {
    expect(questionsFor({ ...base, markerProposed: true, rpeKnown: true })).toEqual([
      "feel",
      "pain",
      "note",
    ]);
    expect(questionsFor({ ...base, rpeKnown: true })).toEqual([]);
  });

  it("asks nothing about an activity that ended more than a day before it arrived", () => {
    const end = STARTED.getTime() + 2556 * 1000;
    expect(questionsFor({ ...base, now: new Date(end + 24 * 3600 * 1000) })).toHaveLength(2);
    expect(questionsFor({ ...base, now: new Date(end + 24 * 3600 * 1000 + 1) })).toEqual([]);
  });
});

describe("stravaRpe", () => {
  it("reads perceived_exertion when it's a usable 1-10 value", () => {
    expect(stravaRpe({ perceived_exertion: 7 })).toBe(7);
    expect(stravaRpe({ perceived_exertion: 6.6 })).toBe(7);
    expect(stravaRpe({ perceived_exertion: null })).toBeNull();
    expect(stravaRpe({ perceived_exertion: 0 })).toBeNull();
    expect(stravaRpe({ perceived_exertion: "7" })).toBeNull();
    expect(stravaRpe({})).toBeNull();
  });
});

describe("createFeedbackRequester().prepare", () => {
  function setup(workouts: Workout[]) {
    const feedback = inMemoryFeedback([1]);
    const weeks: string[] = [];
    const requester = createFeedbackRequester({
      plans: {
        forWeek: async (weekStart) => {
          weeks.push(weekStart);
          return { weekStart, plan: { workouts } } as unknown as StoredPlan;
        },
      },
      feedback: feedback.store,
      timeZone: "Europe/Ljubljana",
      now: () => SOON,
    });
    return { requester, feedback, weeks };
  }

  it("uses the week's plan to pick the questions", async () => {
    const { requester, weeks } = setup([workout({ intensity: "hard" })]);
    expect(await requester.prepare(storedActivity({ startedAt: STARTED }), false)).toEqual([
      "rpe",
      "feel",
      "pain",
      "note",
    ]);
    expect(weeks).toEqual(["2026-09-21"]);
  });

  it("stores an RPE set in Strava and doesn't ask for it again", async () => {
    const { requester, feedback } = setup([]);
    const activity = storedActivity({ startedAt: STARTED, rawData: { perceived_exertion: 4 } });
    expect(await requester.prepare(activity, false)).toEqual([]);
    expect(feedback.rows.get(1)).toMatchObject({ rpe: 4, rpeSource: "strava" });
  });
});

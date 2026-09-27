import { describe, expect, it } from "vitest";
import type { Workout } from "./plan.js";
import { matchPlannedWorkout } from "./plan-match.js";

const TZ = "Europe/Ljubljana";

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

// Tue 22 Sep 2026, 07:00 in Ljubljana, 42:36 of moving time.
const run = {
  externalId: "111",
  sport: "run",
  startedAt: new Date("2026-09-22T05:00:00Z"),
  durationSeconds: 2556,
};

const title = (w: Workout | undefined) => w?.title;

describe("matchPlannedWorkout", () => {
  it("matches the local day and a fitting sport, counting a trail run or brick as a run", () => {
    const workouts = [
      workout({ date: "2026-09-21", title: "Monday run" }),
      workout({ sport: "brick", title: "Brick" }),
      workout({ sport: "swim", title: "Swim" }),
    ];
    expect(title(matchPlannedWorkout({ ...run, sport: "trail_run" }, workouts, TZ))).toBe("Brick");
    expect(title(matchPlannedWorkout({ ...run, sport: "swim" }, workouts, TZ))).toBe("Swim");
    expect(
      matchPlannedWorkout({ ...run, sport: "bike" }, workouts.slice(0, 1), TZ),
    ).toBeUndefined();
  });

  it("uses the local day, not the UTC one", () => {
    // 23:30 UTC on the 21st is already the 22nd in Ljubljana.
    const late = { ...run, startedAt: new Date("2026-09-21T23:30:00Z") };
    expect(title(matchPlannedWorkout(late, [workout({})], TZ))).toBe("Tempo");
  });

  it("prefers the exact sport, then the closer start time", () => {
    const workouts = [
      workout({ sport: "brick", start_time: "07:00", title: "Brick" }),
      workout({ start_time: "18:00", title: "Evening run" }),
      workout({ start_time: "06:30", title: "Morning run" }),
    ];
    expect(title(matchPlannedWorkout(run, workouts, TZ))).toBe("Morning run");
  });

  it("skips a session another activity already fulfilled, but keeps its own", () => {
    const workouts = [
      workout({ title: "Taken", strava_activity_id: "999" }),
      workout({ start_time: "18:00", title: "Free" }),
    ];
    expect(title(matchPlannedWorkout(run, workouts, TZ))).toBe("Free");
    expect(title(matchPlannedWorkout({ ...run, externalId: "999" }, workouts, TZ))).toBe("Taken");
  });

  it("ignores an activity far shorter or longer than planned, except for a brick", () => {
    const long = [workout({ duration_minutes: 120, title: "Long run" })];
    expect(matchPlannedWorkout({ ...run, durationSeconds: 15 * 60 }, long, TZ)).toBeUndefined();
    expect(matchPlannedWorkout({ ...run, durationSeconds: 400 * 60 }, long, TZ)).toBeUndefined();
    expect(title(matchPlannedWorkout({ ...run, durationSeconds: 60 * 60 }, long, TZ))).toBe(
      "Long run",
    );
    const brick = [workout({ sport: "brick", duration_minutes: 120, title: "Brick" })];
    expect(title(matchPlannedWorkout({ ...run, durationSeconds: 15 * 60 }, brick, TZ))).toBe(
      "Brick",
    );
  });
});

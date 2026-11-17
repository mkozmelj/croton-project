import pino from "pino";
import { describe, expect, it } from "vitest";
import type { StoredPlan } from "../db/training-plans.js";
import type { ActivityUpdate } from "../integrations/strava/client.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import type { WeekPlan, Workout } from "../training/plan.js";
import { createPlanLinker } from "./plan-link.js";

// The fixture activity: a run on Tue 22 Sep 2026, 07:00 in Ljubljana, 42:36, Strava id 111.
function workout(overrides: Partial<Workout>): Workout {
  return {
    date: "2026-09-22",
    start_time: "07:00",
    sport: "run",
    session_type: "run_threshold",
    brick_with_previous: false,
    id: 7,
    status: "upcoming",
    activity_id: null,
    title: "Tempo",
    duration_minutes: 45,
    intensity: "hard",
    steps: null,
    structure: [],
    targets: null,
    field_test: null,
    notes: null,
    ...overrides,
  };
}

function setup(workouts: Workout[] | null, { canWrite = true, exists = true } = {}) {
  let plan: WeekPlan | null = workouts && {
    week_start: "2026-09-21",
    phase: "base",
    focus: "Aerobic base",
    workouts,
    weekly_targets: { total_hours: 5, run_km: 30, bike_km: null, swim_km: null, easy_percent: 80 },
  };
  const saves: { workoutId: number; activityId: number; status: string }[] = [];
  const updates: { id: number; update: ActivityUpdate }[] = [];
  const linker = createPlanLinker({
    plans: {
      forWeek: async (weekStart) =>
        plan && ({ weekStart, plan, recapNotes: null, agentAnalysis: null } satisfies StoredPlan),
      setMatch: async (workoutId, activityId, status) => {
        saves.push({ workoutId, activityId, status });
        if (plan) {
          plan = {
            ...plan,
            workouts: plan.workouts.map((w) =>
              w.id === workoutId ? { ...w, activity_id: activityId, status } : w,
            ),
          };
        }
      },
    },
    strava: {
      updateActivity: async (id, update) => {
        updates.push({ id, update });
        return exists;
      },
    },
    canWrite: async () => canWrite,
    timeZone: "Europe/Ljubljana",
    logger: pino({ level: "silent" }),
  });
  return { linker, saves, updates, plan: () => plan };
}

describe("createPlanLinker().link", () => {
  it("records the match and gives the Strava activity the planned title and description", async () => {
    const { linker, updates, plan } = setup([workout({ title: "Tempo intervals" })]);
    const matched = await linker.link(storedActivity({ notes: "Felt windy" }));
    expect(matched?.title).toBe("Tempo intervals");
    expect(plan()?.workouts[0]).toMatchObject({ activity_id: 1, status: "done" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe(111);
    expect(updates[0]?.update.name).toBeUndefined();
    expect(updates[0]?.update.description).toMatch(
      /^Felt windy\n\nPlan: Tempo intervals \(hard\)\nDuration: 43 \/ 45 min\n/,
    );
  });

  it("does nothing without a plan or a matching session", async () => {
    for (const workouts of [null, [workout({ sport: "swim" })]]) {
      const { linker, saves, updates } = setup(workouts);
      expect(await linker.link(storedActivity())).toBeNull();
      expect(saves).toHaveLength(0);
      expect(updates).toHaveLength(0);
    }
  });

  it("still records the match without the activity:write scope, but leaves Strava alone", async () => {
    const { linker, updates, plan } = setup([workout({})], { canWrite: false });
    expect(await linker.link(storedActivity())).not.toBeNull();
    expect(plan()?.workouts[0]?.activity_id).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("doesn't re-save a match that's already recorded, and survives a deleted activity", async () => {
    const { linker, saves, updates } = setup([workout({ activity_id: 1, status: "done" })], {
      exists: false,
    });
    expect(await linker.link(storedActivity())).not.toBeNull();
    expect(saves).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  it("records a session done well short of its active minutes as partial", async () => {
    const { linker, saves } = setup([workout({ duration_minutes: 60 })]);
    await linker.link(storedActivity());
    expect(saves).toEqual([{ workoutId: 7, activityId: 1, status: "partial" }]);
  });

  it("leaves a second run that day unmatched once the session is taken", async () => {
    const { linker, updates } = setup([workout({})]);
    await linker.link(storedActivity());
    const second = storedActivity({ id: 2, externalId: "222" });
    expect(await linker.link(second)).toBeNull();
    expect(updates).toHaveLength(1);
  });
});

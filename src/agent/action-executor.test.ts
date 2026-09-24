import { describe, expect, it } from "vitest";
import { GoalConflictError, type GoalWithEvent, type NewGoal } from "../db/goals.js";
import type { Marker } from "../training/markers.js";
import { createActionExecutor } from "./action-executor.js";
import type { ApplyPlanRequest } from "./plan-booking.js";
import { inMemoryPending } from "./test-helpers.js";

const NOW = new Date("2026-09-24T10:00:00Z");
const later = new Date(NOW.getTime() + 60_000);

function setup(options: { bookingFails?: boolean; goalConflict?: boolean } = {}) {
  const pending = inMemoryPending(() => NOW);
  const created: NewGoal[] = [];
  const recorded: Marker[][] = [];
  const bookings: ApplyPlanRequest[] = [];
  let profile: Record<string, unknown> = { preferences: { longDay: "Sat" } };
  const executor = createActionExecutor({
    pending: pending.store,
    goals: {
      create: async (goal) => {
        if (options.goalConflict) throw new GoalConflictError(goal.goal.season);
        created.push(goal);
        return { ...goal.goal, event: goal.event } as unknown as GoalWithEvent;
      },
    },
    profile: {
      get: async () => profile as never,
      update: async (changes) => {
        profile = { ...profile, ...changes };
      },
    },
    fitness: {
      record: async (markers) => {
        recorded.push([...markers]);
      },
    },
    booking: {
      apply: async (request) => {
        if (options.bookingFails) throw new Error("calendar down");
        bookings.push(request);
        return { booked: 2, calendarConnected: true };
      },
    },
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  return { executor, pending, created, recorded, bookings, profile: () => profile };
}

const plan = {
  week_start: "2026-09-28",
  phase: null,
  focus: "f",
  workouts: [],
  weekly_targets: { total_hours: 1, run_km: null, bike_km: null, swim_km: null, easy_percent: 80 },
};

describe("createActionExecutor", () => {
  it("writes a goal on confirm, and a second tap finds nothing", async () => {
    const { executor, pending, created } = setup();
    const row = await pending.store.create({
      chatId: 1,
      actionType: "set_goal",
      payload: {
        event: {
          name: "Test Race",
          date: "2027-06-13",
          sport: "run",
          distance: null,
          location: null,
        },
        goal: {
          season: 2027,
          priority: "B",
          goalType: "finish",
          target: null,
          targetSeconds: null,
          notes: null,
        },
        replaceGoal: null,
      },
      expiresAt: later,
    });
    expect(await executor.confirm(row.id, 1)).toContain("Saved: B goal Test Race");
    expect(created).toHaveLength(1);
    expect(await executor.confirm(row.id, 1)).toContain("expired or was already handled");
    expect(created).toHaveLength(1);
  });

  it("explains a goal refused by the one-A-goal rule", async () => {
    const { executor, pending } = setup({ goalConflict: true });
    const row = await pending.store.create({
      chatId: 1,
      actionType: "set_goal",
      payload: {
        event: { name: "X", date: "2027-06-13", sport: "run", distance: null, location: null },
        goal: {
          season: 2027,
          priority: "A",
          goalType: "finish",
          target: null,
          targetSeconds: null,
          notes: null,
        },
        replaceGoal: null,
      },
      expiresAt: later,
    });
    expect(await executor.confirm(row.id, 1)).toContain("already has an active A goal");
  });

  it("saves the profile, stores race VDOTs and ends onboarding", async () => {
    const { executor, pending, recorded, profile } = setup();
    await pending.store.create({
      chatId: 1,
      actionType: "onboarding",
      payload: {},
      expiresAt: later,
    });
    const marker = {
      sport: "run",
      metric: "vdot",
      value: 50,
      measuredOn: "2026-04-12",
      source: "race",
    };
    const row = await pending.store.create({
      chatId: 1,
      actionType: "update_profile",
      payload: {
        name: null,
        background: {
          years_by_sport: [{ sport: "run", years: 5 }],
          typical_weekly_hours: 6,
          recent_results: [],
          notes: null,
        },
        availability: "Tue/Thu mornings",
        injuryNotes: null,
        raceMarkers: [marker],
      },
      expiresAt: later,
    });
    expect(await executor.confirm(row.id, 1)).toContain("Stored VDOT 50.0");
    expect(recorded).toEqual([[marker]]);
    expect(profile().preferences).toEqual({ longDay: "Sat", availability: "Tue/Thu mornings" });
    expect(await pending.store.live(1, ["onboarding"])).toHaveLength(0);
  });

  it("books a plan with a booking key stable across retries", async () => {
    const { executor, pending, bookings } = setup();
    const row = await pending.store.create({
      chatId: 1,
      actionType: "apply_plan",
      payload: { plan, recapNotes: "fine", agentAnalysis: "recap", reason: null },
      expiresAt: later,
    });
    expect(await executor.confirm(row.id, 1)).toContain("2 sessions put in your calendar");
    expect(bookings[0]).toMatchObject({
      bookingKey: `plan-${row.id}`,
      today: "2026-09-24",
      recapNotes: "fine",
    });
  });

  it("restores the proposal when execution fails, so Confirm works again", async () => {
    const { executor, pending } = setup({ bookingFails: true });
    const row = await pending.store.create({
      chatId: 1,
      actionType: "apply_plan",
      payload: { plan, recapNotes: null, agentAnalysis: null, reason: null },
      expiresAt: later,
    });
    await expect(executor.confirm(row.id, 1)).rejects.toThrow("calendar down");
    expect((await pending.store.live(1)).map((r) => r.id)).toEqual([row.id]);
  });

  it("cancels without writing, and ignores other chats", async () => {
    const { executor, pending, created } = setup();
    const row = await pending.store.create({
      chatId: 1,
      actionType: "set_goal",
      payload: {},
      expiresAt: later,
    });
    expect(await executor.confirm(row.id, 2)).toContain("expired");
    expect(await executor.cancel(row.id, 1)).toContain("Cancelled");
    expect(created).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import type { SavePlan, StoredPlan } from "../db/training-plans.js";
import type { CalendarClient, EventBody } from "../integrations/google/calendar.js";
import type {
  CalendarEvent,
  IntervalsClient,
  NewWorkoutEvent,
} from "../integrations/intervals/client.js";
import type { WeekPlan, Workout } from "../training/plan.js";
import { createPlanBooking } from "./plan-booking.js";

const workout = (date: string, title: string, eventId: string | null = null): Workout => ({
  date,
  start_time: "07:00",
  sport: "run",
  title,
  duration_minutes: 45,
  intensity: "easy",
  steps: null,
  structure: [{ segment: "main", description: "45 min Z2" }],
  targets: null,
  field_test: null,
  notes: null,
  calendar_event_id: eventId,
});

const plan = (workouts: Workout[]): WeekPlan => ({
  week_start: "2026-09-21",
  phase: "base",
  focus: "f",
  workouts,
  weekly_targets: { total_hours: 3, run_km: 25, bike_km: null, swim_km: null, easy_percent: 85 },
});

function setup(
  stored: StoredPlan | null,
  connected = true,
  intervals: Partial<IntervalsClient> | null = null,
) {
  const saved: SavePlan[] = [];
  const upserts: [string, EventBody][] = [];
  const deletes: string[] = [];
  const calendar: CalendarClient = {
    listEvents: async () => [],
    upsertEvent: async (id, body) => {
      upserts.push([id, body]);
    },
    deleteEvent: async (id) => {
      deletes.push(id);
    },
  };
  const booking = createPlanBooking({
    plans: { forWeek: async () => stored, save: async (p) => void saved.push(p) },
    calendar: async () => (connected ? calendar : null),
    intervals: intervals && {
      athlete: async () => ({ id: "i1", sportSettings: [] }),
      events: async () => [],
      createEvents: async () => [],
      deleteEvent: async () => {},
      ...intervals,
    },
    timeZone: "Europe/Ljubljana",
  });
  return { booking, saved, upserts, deletes };
}

describe("createPlanBooking().apply", () => {
  it("keeps past days, replaces future events, and saves the ids", async () => {
    const stored = {
      weekStart: "2026-09-21",
      plan: plan([
        workout("2026-09-22", "Done run", "old1"),
        workout("2026-09-25", "Old Fri", "old2"),
      ]),
      recapNotes: null,
      agentAnalysis: null,
    };
    const { booking, saved, upserts, deletes } = setup(stored);
    const result = await booking.apply({
      plan: plan([workout("2026-09-22", "Rewritten past"), workout("2026-09-26", "New Sat")]),
      bookingKey: "plan-7",
      today: "2026-09-24",
    });

    expect(result).toEqual({ booked: 1, calendarConnected: true, watch: null });
    expect(deletes).toEqual(["old2"]);
    expect(upserts.map(([, body]) => body.summary)).toEqual(["🏃 New Sat (45 min)"]);
    expect(upserts[0]?.[1].start).toEqual({
      dateTime: "2026-09-26T07:00:00",
      timeZone: "Europe/Ljubljana",
    });
    expect(saved[0]?.plan.workouts.map((w) => [w.title, w.calendar_event_id])).toEqual([
      ["Done run", "old1"],
      ["New Sat", upserts[0]?.[0]],
    ]);
  });

  it("uses the same event ids when a booking is retried", async () => {
    const first = setup(null);
    const second = setup(null);
    const request = {
      plan: plan([workout("2026-09-26", "Sat")]),
      bookingKey: "plan-7",
      today: "2026-09-24",
    };
    await first.booking.apply(request);
    await second.booking.apply(request);
    expect(first.upserts[0]?.[0]).toBe(second.upserts[0]?.[0]);
    expect(first.upserts[0]?.[0]).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("saves the plan without events while the calendar isn't connected", async () => {
    const { booking, saved } = setup(null, false);
    const result = await booking.apply({
      plan: plan([workout("2026-09-26", "Sat")]),
      bookingKey: "k",
      today: "2026-09-24",
      agentAnalysis: "recap",
    });
    expect(result).toEqual({ booked: 0, calendarConnected: false, watch: null });
    expect(saved[0]).toMatchObject({ agentAnalysis: "recap" });
    expect(saved[0]?.plan.workouts[0]?.calendar_event_id).toBeNull();
  });

  describe("watch workouts (ADR-020)", () => {
    const withSteps = (w: Workout): Workout => ({
      ...w,
      steps: [
        {
          repeat: 1,
          steps: [
            {
              label: "Easy",
              duration_seconds: 2700,
              distance_meters: null,
              target: { metric: "hr", min: 136, max: 150 },
            },
          ],
        },
      ],
    });
    const existing = (id: number, start: string, externalId: string | null): CalendarEvent => ({
      id,
      category: "WORKOUT",
      start_date_local: start,
      external_id: externalId,
    });

    function intervalsFake(events: CalendarEvent[]) {
      const ranges: [string, string][] = [];
      const deleted: number[] = [];
      const created: NewWorkoutEvent[][] = [];
      const fake: Partial<IntervalsClient> = {
        athlete: async () => ({
          id: "i1",
          sportSettings: [{ types: ["Run"], lthr: 170 }],
        }),
        events: async (oldest, newest) => {
          ranges.push([oldest, newest]);
          return events;
        },
        createEvents: async (list) => {
          created.push([...list]);
          return [];
        },
        deleteEvent: async (id) => {
          deleted.push(id);
        },
      };
      return { fake, ranges, deleted, created };
    }

    it("replaces the bot's workouts from today on and sends the upcoming watch sessions", async () => {
      const { fake, ranges, deleted, created } = intervalsFake([
        existing(1, "2026-09-24T07:00:00", "croton:plan-3:1"),
        existing(2, "2026-09-26T07:00:00", "croton:plan-3:2"),
        existing(3, "2026-09-25T18:00:00", null),
        existing(4, "2026-09-25T18:00:00", "other-app:1"),
      ]);
      const { booking, saved } = setup(null, false, fake);
      const result = await booking.apply({
        plan: plan([
          withSteps(workout("2026-09-22", "Past run")),
          withSteps(workout("2026-09-25", "Easy run")),
          { ...withSteps(workout("2026-09-26", "Gym")), sport: "strength" },
          workout("2026-09-27", "Run without steps"),
        ]),
        bookingKey: "plan-7",
        today: "2026-09-24",
      });

      expect(ranges).toEqual([["2026-09-24", "2026-09-27"]]);
      expect(deleted).toEqual([1, 2]);
      expect(created).toHaveLength(1);
      expect(created[0]).toEqual([
        expect.objectContaining({
          name: "Easy run",
          type: "Run",
          start_date_local: "2026-09-25T07:00:00",
          description: "- Easy 45m 80-88.2% LTHR",
          external_id: "croton:plan-7:0",
        }),
      ]);
      expect(result.watch).toEqual({ sent: 1 });
      expect(saved).toHaveLength(1);
    });

    it("looks from Monday when the week hasn't started", async () => {
      const { fake, ranges } = intervalsFake([]);
      const { booking } = setup(null, false, fake);
      await booking.apply({ plan: plan([]), bookingKey: "k", today: "2026-09-19" });
      expect(ranges).toEqual([["2026-09-21", "2026-09-27"]]);
    });

    it("doesn't save the plan when Intervals.icu fails, so Confirm can be retried", async () => {
      const { booking, saved } = setup(null, false, {
        events: async () => {
          throw new Error("down");
        },
      });
      await expect(
        booking.apply({ plan: plan([]), bookingKey: "k", today: "2026-09-24" }),
      ).rejects.toThrow("down");
      expect(saved).toEqual([]);
    });
  });
});

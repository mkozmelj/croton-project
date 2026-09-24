import { describe, expect, it } from "vitest";
import type { SavePlan, StoredPlan } from "../db/training-plans.js";
import type { CalendarClient, EventBody } from "../integrations/google/calendar.js";
import type { WeekPlan, Workout } from "../training/plan.js";
import { createPlanBooking } from "./plan-booking.js";

const workout = (date: string, title: string, eventId: string | null = null): Workout => ({
  date,
  start_time: "07:00",
  sport: "run",
  title,
  duration_minutes: 45,
  intensity: "easy",
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

function setup(stored: StoredPlan | null, connected = true) {
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

    expect(result).toEqual({ booked: 1, calendarConnected: true });
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
    expect(result).toEqual({ booked: 0, calendarConnected: false });
    expect(saved[0]).toMatchObject({ agentAnalysis: "recap" });
    expect(saved[0]?.plan.workouts[0]?.calendar_event_id).toBeNull();
  });
});

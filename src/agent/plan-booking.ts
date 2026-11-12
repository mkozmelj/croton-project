import type { TrainingPlanStore } from "../db/training-plans.js";
import type { CalendarClient } from "../integrations/google/calendar.js";
import { workoutEvent, workoutEventId } from "../integrations/google/plan-events.js";
import type { IntervalsClient } from "../integrations/intervals/client.js";
import {
  EXTERNAL_ID_PREFIX,
  workoutEvent as watchEvent,
  watchExternalId,
} from "../integrations/intervals/workouts.js";
import { sortedWorkouts, type WeekPlan, type Workout } from "../training/plan.js";
import { addDays } from "../utils/dates.js";

type BookingDeps = {
  plans: Pick<TrainingPlanStore, "forWeek" | "save">;
  // Absent while Google Calendar isn't connected: the plan is saved without events.
  calendar: () => Promise<CalendarClient | null>;
  // ADR-020: absent while Intervals.icu isn't configured: no watch workouts are sent.
  intervals?: Pick<IntervalsClient, "athlete" | "events" | "createEvents" | "deleteEvent"> | null;
  timeZone: string;
};

export type ApplyPlanRequest = {
  plan: WeekPlan;
  // Stable per confirmation (the pending action id): retries reuse the same event ids.
  bookingKey: string;
  today: string;
  recapNotes?: string | null;
  agentAnalysis?: string | null;
};

export type ApplyPlanResult = {
  booked: number;
  calendarConnected: boolean;
  // Sessions sent to Intervals.icu as watch workouts; null when Intervals.icu isn't configured.
  watch: { sent: number } | null;
};

export type PlanBooking = {
  // Saves a confirmed plan and puts its sessions from today on in the calendar. Days before
  // today keep the stored plan's sessions and events (they already happened, or didn't).
  apply(request: ApplyPlanRequest): Promise<ApplyPlanResult>;
};

export function createPlanBooking(deps: BookingDeps): PlanBooking {
  return {
    async apply({ plan, bookingKey, today, recapNotes, agentAnalysis }) {
      const existing = await deps.plans.forWeek(plan.week_start);
      const kept = (existing?.plan.workouts ?? []).filter((w) => w.date < today);
      const replaced = (existing?.plan.workouts ?? []).filter((w) => w.date >= today);
      const upcoming = sortedWorkouts(plan.workouts.filter((w) => w.date >= today));

      const calendar = await deps.calendar();
      let booked: Workout[] = upcoming.map((w) => ({ ...w, calendar_event_id: null }));
      if (calendar) {
        // Old events first: a failure part-way is safe to retry (deletes of missing events
        // succeed, and the new events have deterministic ids).
        for (const workout of replaced) {
          if (workout.calendar_event_id) await calendar.deleteEvent(workout.calendar_event_id);
        }
        booked = [];
        for (const [index, workout] of upcoming.entries()) {
          const id = workoutEventId(bookingKey, index);
          await calendar.upsertEvent(id, workoutEvent(workout, deps.timeZone));
          booked.push({ ...workout, calendar_event_id: id });
        }
      }

      // After the calendar, before the save: a failure leaves the confirmation to retry, and a
      // retry deletes whatever a failed attempt created.
      const watch = deps.intervals
        ? await sendWatchWorkouts(deps.intervals, plan.week_start, today, upcoming, bookingKey)
        : null;

      await deps.plans.save({
        plan: { ...plan, workouts: sortedWorkouts([...kept, ...booked]) },
        ...(recapNotes !== undefined ? { recapNotes } : {}),
        ...(agentAnalysis !== undefined ? { agentAnalysis } : {}),
      });
      return {
        booked: calendar ? booked.length : 0,
        calendarConnected: calendar !== null,
        watch,
      };
    },
  };
}

// Replaces the bot's Intervals.icu workouts from today to the end of the week with the
// upcoming sessions that are watch workouts (run, bike, swim with steps).
async function sendWatchWorkouts(
  intervals: NonNullable<BookingDeps["intervals"]>,
  weekStart: string,
  today: string,
  upcoming: readonly Workout[],
  bookingKey: string,
): Promise<{ sent: number }> {
  const from = today > weekStart ? today : weekStart;
  for (const event of await intervals.events(from, addDays(weekStart, 6))) {
    const ours = event.external_id?.startsWith(EXTERNAL_ID_PREFIX) ?? false;
    if (ours && event.start_date_local.slice(0, 10) >= today) await intervals.deleteEvent(event.id);
  }
  const { sportSettings } = await intervals.athlete();
  const events = upcoming.flatMap((workout, index) => {
    const event = watchEvent(workout, {
      externalId: watchExternalId(bookingKey, index),
      settings: sportSettings,
    });
    return event ? [event] : [];
  });
  await intervals.createEvents(events);
  return { sent: events.length };
}

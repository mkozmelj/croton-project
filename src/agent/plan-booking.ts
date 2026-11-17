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
import { replacements } from "../training/plan-revisions.js";
import { addDays } from "../utils/dates.js";

type BookingDeps = {
  plans: Pick<TrainingPlanStore, "forWeek" | "applyWeek">;
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
  // today, and sessions already done today, keep their stored sessions and events. The
  // sessions it supersedes stay stored as replaced (ADR-021).
  apply(request: ApplyPlanRequest): Promise<ApplyPlanResult>;
};

export function createPlanBooking(deps: BookingDeps): PlanBooking {
  return {
    async apply({ plan, bookingKey, today, recapNotes, agentAnalysis }) {
      const existing = (await deps.plans.forWeek(plan.week_start))?.plan.workouts ?? [];
      const settled = (w: Workout) =>
        w.date < today || w.status === "done" || w.status === "partial";
      const kept = existing.filter(settled);
      const replaced = existing.filter((w) => !settled(w));
      // A session already done today isn't planned a second time.
      const doneAgain = (w: Workout) =>
        kept.some(
          (k) => k.date === w.date && k.sport === w.sport && k.session_type === w.session_type,
        );
      const upcoming = sortedWorkouts(
        plan.workouts.filter((w) => w.date >= today && !doneAgain(w)),
      ).map(({ id: _id, status: _status, activity_id: _activity, ...w }) => w);

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

      const { workouts: _workouts, ...header } = plan;
      const sessions = booked.map((workout, index) => {
        const before = booked[index - 1];
        const bikeLeg = workout.brick_with_previous && before?.sport === "bike";
        return {
          key: sessionKey(bookingKey, index),
          workout,
          brickWithKey:
            bikeLeg && before.date === workout.date ? sessionKey(bookingKey, index - 1) : null,
        };
      });
      await deps.plans.applyWeek({
        header,
        sessions,
        replace: replacements(replaced, sessions, today),
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

// The planned_workouts key of a booked session: stable per confirmation, so a retry upserts
// the same rows (ADR-009).
export function sessionKey(bookingKey: string, index: number): string {
  return `croton:${bookingKey}:${index}`;
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

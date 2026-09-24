import type { TrainingPlanStore } from "../db/training-plans.js";
import type { CalendarClient } from "../integrations/google/calendar.js";
import { workoutEvent, workoutEventId } from "../integrations/google/plan-events.js";
import { sortedWorkouts, type WeekPlan, type Workout } from "../training/plan.js";

type BookingDeps = {
  plans: Pick<TrainingPlanStore, "forWeek" | "save">;
  // Absent while Google Calendar isn't connected: the plan is saved without events.
  calendar: () => Promise<CalendarClient | null>;
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

export type ApplyPlanResult = { booked: number; calendarConnected: boolean };

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

      await deps.plans.save({
        plan: { ...plan, workouts: sortedWorkouts([...kept, ...booked]) },
        ...(recapNotes !== undefined ? { recapNotes } : {}),
        ...(agentAnalysis !== undefined ? { agentAnalysis } : {}),
      });
      return { booked: calendar ? booked.length : 0, calendarConnected: calendar !== null };
    },
  };
}

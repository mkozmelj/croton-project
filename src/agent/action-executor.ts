import type { AthleteProfileStore } from "../db/athlete-profile.js";
import { GoalConflictError, type GoalStore } from "../db/goals.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";
import { formatMarkerValue } from "../training/markers.js";
import { localDate } from "../utils/dates.js";
import {
  addMarkerPayload,
  applyPlanPayload,
  isConfirmation,
  setGoalPayload,
  updateProfilePayload,
} from "./actions.js";
import type { FitnessService } from "./fitness.js";
import type { PlanBooking } from "./plan-booking.js";

type ExecutorDeps = {
  pending: Pick<PendingActionStore, "consume" | "restore" | "clear">;
  goals: Pick<GoalStore, "create">;
  profile: Pick<AthleteProfileStore, "get" | "update">;
  fitness: Pick<FitnessService, "record">;
  booking: PlanBooking;
  timeZone: string;
  now?: () => Date;
};

export type ActionExecutor = {
  // Runs a confirmed proposal. Returns the text for the athlete.
  confirm(id: number, chatId: number): Promise<string>;
  cancel(id: number, chatId: number): Promise<string>;
};

const EXPIRED =
  "This proposal has expired or was already handled. Ask again (or run /recap for a new plan).";

// ADR-007: the second step of every confirm-before-write flow. Works after a restart: all
// state is the pending_actions row.
export function createActionExecutor(deps: ExecutorDeps): ActionExecutor {
  const now = deps.now ?? (() => new Date());

  async function execute(row: PendingActionRow): Promise<string> {
    switch (row.actionType) {
      case "set_goal": {
        const { event, goal, replaceGoal } = setGoalPayload.parse(row.payload);
        try {
          const created = await deps.goals.create({ event, goal }, replaceGoal?.id);
          return `Saved: ${created.priority} goal ${created.event.name} on ${created.event.date}. /goals lists your goals.`;
        } catch (error) {
          if (!(error instanceof GoalConflictError)) throw error;
          return `Not saved: ${goal.season} already has an active A goal. Tell me if the new one should replace it.`;
        }
      }

      case "update_profile": {
        const p = updateProfilePayload.parse(row.payload);
        const current = await deps.profile.get();
        await deps.profile.update({
          ...(p.name ? { name: p.name } : {}),
          ...(p.background ? { background: p.background } : {}),
          ...(p.injuryNotes ? { injuryNotes: p.injuryNotes } : {}),
          ...(p.availability
            ? { preferences: { ...current?.preferences, availability: p.availability } }
            : {}),
        });
        if (p.raceMarkers.length > 0) await deps.fitness.record(p.raceMarkers);
        // The background is what onboarding collects; once it's stored, onboarding is done.
        if (p.background) await deps.pending.clear(row.chatId, ["onboarding"]);
        const vdots = p.raceMarkers.map((m) => formatMarkerValue(m.metric, m.value));
        return `Profile saved.${vdots.length > 0 ? ` Stored ${vdots.join(", ")} from your race results.` : ""} /profile shows it.`;
      }

      case "add_fitness_marker": {
        const { markers } = addMarkerPayload.parse(row.payload);
        await deps.fitness.record(markers);
        return `Saved ${markers.map((m) => formatMarkerValue(m.metric, m.value)).join(", ")}. Zones are updated; /profile shows them.`;
      }

      case "apply_plan": {
        const payload = applyPlanPayload.parse(row.payload);
        const result = await deps.booking.apply({
          plan: payload.plan,
          bookingKey: `plan-${row.id}`,
          today: localDate(now(), deps.timeZone),
          recapNotes: payload.recapNotes,
          agentAnalysis: payload.agentAnalysis,
        });
        if (!result.calendarConnected) {
          return "Plan saved. Google Calendar isn't connected, so nothing was booked (/connect calendar). /plan shows the week.";
        }
        return `Plan saved and ${result.booked} session${result.booked === 1 ? "" : "s"} put in your calendar. /plan shows the week.`;
      }

      case "recap":
      case "onboarding":
        return "Nothing to confirm.";
    }
  }

  return {
    async confirm(id, chatId) {
      const row = await deps.pending.consume(id, chatId);
      if (!row || !isConfirmation(row.actionType)) return EXPIRED;
      try {
        return await execute(row);
      } catch (error) {
        // Put it back so Confirm can be tapped again once the cause is fixed.
        await deps.pending.restore(row);
        throw error;
      }
    },

    async cancel(id, chatId) {
      const row = await deps.pending.consume(id, chatId);
      return row ? "Cancelled, nothing was saved." : EXPIRED;
    },
  };
}

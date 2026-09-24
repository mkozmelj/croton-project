import type { ActivitySummary } from "../db/activities.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import { FIELD_TEST_SPORTS, markersFromFieldTest } from "../training/field-tests.js";
import { localDate, weekStart } from "../utils/dates.js";
import { type AddMarkerPayload, CONFIRMATION_TTL_MS } from "./actions.js";

type ProposerDeps = {
  plans: Pick<TrainingPlanStore, "forWeek">;
  pending: Pick<PendingActionStore, "create">;
  chatId: number;
  timeZone: string;
  now?: () => Date;
};

export type FieldTestProposer = {
  // When the activity completes a field test planned for its day, proposes the resulting
  // markers for confirmation (ADR-016 source 3). Empty otherwise.
  propose(activity: ActivitySummary): Promise<PendingActionRow[]>;
};

export function createFieldTestProposer(deps: ProposerDeps): FieldTestProposer {
  const now = deps.now ?? (() => new Date());

  return {
    async propose(activity) {
      const day = localDate(activity.startedAt, deps.timeZone);
      const stored = await deps.plans.forWeek(weekStart(day));
      const tests = (stored?.plan.workouts ?? []).flatMap((w) =>
        w.date === day && w.field_test && FIELD_TEST_SPORTS[w.field_test].includes(activity.sport)
          ? [w.field_test]
          : [],
      );
      const proposals: PendingActionRow[] = [];
      for (const test of new Set(tests)) {
        const markers = markersFromFieldTest(test, {
          externalId: activity.externalId,
          sport: activity.sport,
          startedOn: day,
          laps: activity.laps,
        });
        if (markers.length === 0) continue;
        const payload: AddMarkerPayload = { markers };
        proposals.push(
          await deps.pending.create({
            chatId: deps.chatId,
            actionType: "add_fitness_marker",
            payload,
            expiresAt: new Date(now().getTime() + CONFIRMATION_TTL_MS),
          }),
        );
      }
      return proposals;
    },
  };
}

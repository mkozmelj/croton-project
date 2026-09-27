import { z } from "zod";
import type { Activity } from "../db/activities.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import { breakthroughMarkers } from "../training/breakthroughs.js";
import { FIELD_TEST_SPORTS, markersFromFieldTest } from "../training/field-tests.js";
import type { Marker } from "../training/markers.js";
import { localDate, weekStart } from "../utils/dates.js";
import { type AddMarkerPayload, CONFIRMATION_TTL_MS } from "./actions.js";
import type { FitnessService } from "./fitness.js";

type ProposerDeps = {
  plans: Pick<TrainingPlanStore, "forWeek">;
  pending: Pick<PendingActionStore, "create">;
  fitness: Pick<FitnessService, "latest">;
  chatId: number;
  timeZone: string;
  now?: () => Date;
};

export type MarkerProposer = {
  // New fitness markers from a just-synced activity, as proposals to confirm (ADR-016): a
  // completed field test planned for its day (source 3), otherwise a workout that clearly
  // beat a current threshold (breakthrough check). Empty when neither applies.
  propose(activity: Activity): Promise<PendingActionRow[]>;
};

// The Strava fields the breakthrough check needs that the activity row doesn't keep.
const rawPower = z.object({
  average_watts: z.number().nullish(),
  device_watts: z.boolean().nullish(),
  trainer: z.boolean().nullish(),
});

export function createMarkerProposer(deps: ProposerDeps): MarkerProposer {
  const now = deps.now ?? (() => new Date());

  const create = (markers: Marker[]) => {
    const payload: AddMarkerPayload = { markers };
    return deps.pending.create({
      chatId: deps.chatId,
      actionType: "add_fitness_marker",
      payload,
      expiresAt: new Date(now().getTime() + CONFIRMATION_TTL_MS),
    });
  };

  async function fieldTestProposals(activity: Activity, day: string) {
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
      if (markers.length > 0) proposals.push(await create(markers));
    }
    return proposals;
  }

  return {
    async propose(activity) {
      const day = localDate(activity.startedAt, deps.timeZone);
      const fromTests = await fieldTestProposals(activity, day);
      // A planned test already turned into markers: no second proposal for the same effort.
      if (fromTests.length > 0) return fromTests;

      const raw = rawPower.safeParse(activity.rawData);
      const markers = breakthroughMarkers(
        {
          externalId: activity.externalId,
          name: activity.name,
          sport: activity.sport,
          startedOn: day,
          movingSeconds: activity.durationSeconds,
          distanceMeters: activity.distanceMeters,
          avgWatts: raw.success ? (raw.data.average_watts ?? null) : null,
          measuredPower: raw.success && raw.data.device_watts === true,
          indoor: raw.success && raw.data.trainer === true,
          laps: activity.laps,
        },
        await deps.fitness.latest(),
      );
      return markers.length > 0 ? [await create(markers)] : [];
    },
  };
}

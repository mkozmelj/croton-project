import type { PlannedWorkoutRow } from "../db/planned-workouts.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import { addDays, localDate } from "../utils/dates.js";

// ADR-021 morning check-in (08:00 local). No Claude call: it only moves statuses on.

// Days a session waits for a match or an answer before it counts as skipped.
export const ANSWER_DAYS = 3;

type CheckInDeps = {
  plans: Pick<TrainingPlanStore, "markUnconfirmed" | "expireUnanswered">;
  timeZone: string;
  now?: () => Date;
};

export type CheckInRun = {
  // Past sessions no activity matched, newly waiting for the athlete's answer.
  toAsk: PlannedWorkoutRow[];
  // Sessions that waited ANSWER_DAYS without an answer and now count as skipped.
  expired: number;
};

export type CheckIn = { run(): Promise<CheckInRun> };

export function createCheckIn(deps: CheckInDeps): CheckIn {
  const now = deps.now ?? (() => new Date());
  return {
    async run() {
      const today = localDate(now(), deps.timeZone);
      const oldestAsked = addDays(today, -ANSWER_DAYS);
      // Expired first, so a session older than the answer window (a missed run, the first
      // run after a deploy) is skipped outright instead of asked about.
      const expired = await deps.plans.expireUnanswered(oldestAsked);
      const toAsk = await deps.plans.markUnconfirmed(oldestAsked, today);
      return { toAsk, expired };
    },
  };
}

import type { Logger } from "pino";
import type { Activity } from "../db/activities.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import type { StravaClient } from "../integrations/strava/client.js";
import { planBlock, withPlanBlock } from "../integrations/strava/plan-description.js";
import { completionStatus, type Workout } from "../training/plan.js";
import { matchPlannedWorkout } from "../training/plan-match.js";
import { localDate, weekStart } from "../utils/dates.js";

type LinkerDeps = {
  plans: Pick<TrainingPlanStore, "forWeek" | "setMatch">;
  strava: Pick<StravaClient, "updateActivity">;
  // False until the athlete grants `activity:write` (/reauth strava).
  canWrite: () => Promise<boolean>;
  timeZone: string;
  logger: Logger;
};

export type PlanLinker = {
  // Matches a new activity to the week's confirmed plan, records the match and the session's
  // status (ADR-021), and gives the Strava activity the planned title and a plan/compliance description.
  // Returns the matched workout, or null when the activity wasn't a planned session.
  link(activity: Activity): Promise<Workout | null>;
};

export function createPlanLinker(deps: LinkerDeps): PlanLinker {
  const log = deps.logger.child({ module: "plan-link" });

  return {
    async link(activity) {
      const stored = await deps.plans.forWeek(
        weekStart(localDate(activity.startedAt, deps.timeZone)),
      );
      if (!stored) return null;
      const matched = matchPlannedWorkout(activity, stored.plan.workouts, deps.timeZone);
      if (!matched || matched.id === undefined) return null;

      // Recorded first, so a second activity that day can't take the same session even if
      // the Strava update below fails.
      const status = completionStatus(matched, activity.durationSeconds);
      if (matched.activity_id !== activity.id || matched.status !== status) {
        await deps.plans.setMatch(matched.id, activity.id, status);
      }
      log.info(
        { externalId: activity.externalId, workout: matched.title, status },
        "activity matched",
      );

      if (activity.source !== "strava") return matched;
      if (!(await deps.canWrite())) {
        log.info("no activity:write scope, Strava activity left as is");
        return matched;
      }
      const description = withPlanBlock(activity.notes, planBlock({ workout: matched, activity }));
      const updated = await deps.strava.updateActivity(Number(activity.externalId), {
        description,
      });
      if (!updated) log.warn({ externalId: activity.externalId }, "activity gone before update");
      return matched;
    },
  };
}

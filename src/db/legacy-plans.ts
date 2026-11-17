import { eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import {
  completionStatus,
  isRestDayEntry,
  sortedWorkouts,
  storedWorkoutSchema,
  type Workout,
  withLegacyRests,
} from "../training/plan.js";
import { fallbackSessionType } from "../training/session-types.js";
import type { Database } from "./client.js";
import { activities, plannedWorkouts, trainingPlans } from "./schema.js";
import { rowValues } from "./training-plans.js";

// ADR-021 switchover, run on boot after the migrations: each weekly plan that still holds its
// sessions in `plan.workouts` gets them as planned_workouts rows, then loses the array, in one
// transaction per week. Weeks already moved are skipped, so it's a no-op after the first run.
// Migration 0007 kept a copy of every plan in training_plans_workouts_backup.

const legacyPlan = z.object({
  workouts: z.array(storedWorkoutSchema.extend({ strava_activity_id: z.string().nullish() })),
});

type Linked = { id: number; externalId: string; durationSeconds: number };

export async function moveLegacyPlanSessions(
  db: Database,
  { today, logger }: { today: string; logger: Logger },
): Promise<number> {
  const log = logger.child({ module: "legacy-plans" });
  const weeks = await db
    .select()
    .from(trainingPlans)
    .where(sql`jsonb_exists(${trainingPlans.plan}, 'workouts')`);
  let moved = 0;
  for (const week of weeks) {
    const parsed = legacyPlan.safeParse(week.plan);
    if (!parsed.success) {
      log.warn({ weekStart: week.weekStart }, "stored plan doesn't parse, sessions left in place");
      continue;
    }
    const workouts = sortedWorkouts(parsed.data.workouts);
    const externalIds = workouts.flatMap((w) =>
      w.strava_activity_id ? [w.strava_activity_id] : [],
    );
    const linked: Linked[] =
      externalIds.length > 0
        ? await db
            .select({
              id: activities.id,
              externalId: activities.externalId,
              durationSeconds: activities.durationSeconds,
            })
            .from(activities)
            .where(inArray(activities.externalId, externalIds))
        : [];

    // Keys keep each session's place in the stored week, rest-day entries included.
    const inserts = workouts.flatMap((legacy, index) => {
      if (isRestDayEntry(legacy)) return [];
      const { strava_activity_id: stravaId, ...rest } = legacy;
      const workout: Workout = {
        ...withLegacyRests(rest),
        session_type: legacy.field_test
          ? "field_test"
          : legacy.session_type === "other"
            ? fallbackSessionType(legacy.sport)
            : legacy.session_type,
      };
      const activity = linked.find((a) => a.externalId === stravaId);
      const past = workout.date < today;
      return [
        db
          .insert(plannedWorkouts)
          .values({
            key: `legacy:${week.weekStart}:${index}`,
            ...rowValues(workout, week.weekStart),
            status: activity
              ? completionStatus(workout, activity.durationSeconds)
              : past
                ? "skipped"
                : "upcoming",
            statusSource: activity ? "match" : past ? "backfill" : null,
            activityId: activity?.id ?? null,
          })
          .onConflictDoNothing({ target: plannedWorkouts.key }),
      ];
    });
    await db.batch([
      db
        .update(trainingPlans)
        .set({ plan: sql`${trainingPlans.plan} - 'workouts'` })
        .where(eq(trainingPlans.weekStart, week.weekStart)),
      ...inserts,
    ]);
    moved += inserts.length;
  }
  if (moved > 0) log.info({ weeks: weeks.length, sessions: moved }, "plan sessions moved to rows");
  return moved;
}

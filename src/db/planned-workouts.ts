import { and, asc, eq, getTableColumns, gte, lt, type SQL } from "drizzle-orm";
import type { SessionType } from "../training/session-types.js";
import type { ActivitySummary } from "./activities.js";
import type { ActivityFeedback } from "./activity-feedback.js";
import type { Database } from "./client.js";
import { activities, activityFeedback, plannedWorkouts } from "./schema.js";

// ADR-022: the dashboard's reads of planned_workouts, each session with the activity that
// fulfilled it and that activity's feedback. Read-only; every write stays in
// training-plans.ts (TrainingPlanStore), so there is one way to change a session.

export type PlannedWorkoutRow = typeof plannedWorkouts.$inferSelect;

export type SessionRecord = {
  session: PlannedWorkoutRow;
  activity: ActivitySummary | null;
  feedback: ActivityFeedback | null;
};

export type PlannedWorkoutStore = {
  // Sessions with `from <= date < to` (local dates), every status, in date and time order.
  between(from: string, to: string): Promise<SessionRecord[]>;
  // Every session, oldest first.
  all(): Promise<SessionRecord[]>;
  // Every session of one type, oldest first.
  ofType(type: SessionType): Promise<SessionRecord[]>;
  byId(id: number): Promise<SessionRecord | null>;
};

export function createPlannedWorkoutStore(db: Database): PlannedWorkoutStore {
  const { rawData: _raw, ...activityColumns } = getTableColumns(activities);

  const select = (where: SQL | undefined) =>
    db
      .select({ session: plannedWorkouts, activity: activityColumns, feedback: activityFeedback })
      .from(plannedWorkouts)
      .leftJoin(activities, eq(activities.id, plannedWorkouts.activityId))
      .leftJoin(activityFeedback, eq(activityFeedback.activityId, activities.id))
      .where(where)
      .orderBy(asc(plannedWorkouts.date), asc(plannedWorkouts.startTime), asc(plannedWorkouts.id));

  return {
    between: (from, to) =>
      select(and(gte(plannedWorkouts.date, from), lt(plannedWorkouts.date, to))),
    all: () => select(undefined),
    ofType: (type) => select(eq(plannedWorkouts.sessionType, type)),
    async byId(id) {
      const [row] = await select(eq(plannedWorkouts.id, id));
      return row ?? null;
    },
  };
}

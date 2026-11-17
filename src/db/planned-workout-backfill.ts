import { asc, eq, inArray } from "drizzle-orm";
import { completionStatus, type Workout, type WorkoutInput } from "../training/plan.js";
import type { SessionType } from "../training/session-types.js";
import { weekStart } from "../utils/dates.js";
import type { Database } from "./client.js";
import { activities, plannedWorkouts } from "./schema.js";
import { rowValues } from "./training-plans.js";

// ADR-021 backfill, for the CLIs only: TrainingPeaks planned sessions, and session types for
// rows that only have a fallback type.

export type ImportedSession = {
  key: string;
  workout: Workout;
  activity: { id: number; durationSeconds: number } | null;
};

export type BackfillStore = {
  // Inserts sessions not stored yet; a re-run leaves existing rows alone. Returns how many
  // were new.
  importSessions(sessions: readonly ImportedSession[], today: string): Promise<number>;
  activitiesByExternalId(
    externalIds: readonly string[],
  ): Promise<Map<string, { id: number; durationSeconds: number }>>;
  // Rows whose session type is one of `types`, oldest first.
  withTypes(types: readonly SessionType[], limit: number): Promise<ClassifiableRow[]>;
  setClassification(
    id: number,
    sessionType: SessionType,
    intensity: WorkoutInput["intensity"],
  ): Promise<void>;
};

export type ClassifiableRow = {
  id: number;
  sport: string;
  title: string;
  durationMinutes: number;
  structure: unknown;
  notes: string | null;
};

export function createBackfillStore(db: Database): BackfillStore {
  return {
    async importSessions(sessions, today) {
      let inserted = 0;
      for (const { key, workout, activity } of sessions) {
        const past = workout.date < today;
        const rows = await db
          .insert(plannedWorkouts)
          .values({
            key,
            ...rowValues(workout, weekStart(workout.date)),
            source: "trainingpeaks_import",
            status: activity
              ? completionStatus(workout, activity.durationSeconds)
              : past
                ? "skipped"
                : "upcoming",
            statusSource: activity || past ? "backfill" : null,
            activityId: activity?.id ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: plannedWorkouts.id });
        inserted += rows.length;
      }
      return inserted;
    },

    async activitiesByExternalId(externalIds) {
      if (externalIds.length === 0) return new Map();
      const rows = await db
        .select({
          id: activities.id,
          externalId: activities.externalId,
          durationSeconds: activities.durationSeconds,
        })
        .from(activities)
        .where(inArray(activities.externalId, [...externalIds]));
      return new Map(rows.map((r) => [r.externalId, r]));
    },

    async withTypes(types, limit) {
      return db
        .select({
          id: plannedWorkouts.id,
          sport: plannedWorkouts.sport,
          title: plannedWorkouts.title,
          durationMinutes: plannedWorkouts.durationMinutes,
          structure: plannedWorkouts.structure,
          notes: plannedWorkouts.notes,
        })
        .from(plannedWorkouts)
        .where(inArray(plannedWorkouts.sessionType, [...types]))
        .orderBy(asc(plannedWorkouts.date))
        .limit(limit);
    },

    async setClassification(id, sessionType, intensity) {
      await db
        .update(plannedWorkouts)
        .set({ sessionType, intensity, updatedAt: new Date() })
        .where(eq(plannedWorkouts.id, id));
    },
  };
}

import { asc, eq, inArray } from "drizzle-orm";
import type { WorkoutInput } from "../training/plan.js";
import type { SessionType } from "../training/session-types.js";
import type { Database } from "./client.js";
import { plannedWorkouts } from "./schema.js";

// ADR-021 backfill, for `npm run workouts:classify` only: session types for rows that only have
// a fallback type (sessions planned before session types existed).

export type BackfillStore = {
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

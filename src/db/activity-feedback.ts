import { eq, inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import { activities, activityFeedback } from "./schema.js";

export type ActivityFeedback = typeof activityFeedback.$inferSelect;

// The answer fields; a write sets only the ones it has.
export type FeedbackFields = Partial<
  Pick<ActivityFeedback, "rpe" | "rpeSource" | "feel" | "pain" | "painNote" | "note">
>;

export type ActivityFeedbackStore = {
  // ADR-018: upsert on `activity_id`, touching only the given fields. Null when the activity
  // no longer exists (deleted on Strava after the questions went out).
  set(activityId: number, fields: FeedbackFields): Promise<ActivityFeedback | null>;
  get(activityId: number): Promise<ActivityFeedback | null>;
  // Feedback for these activities, keyed by activity id (activities without any are absent).
  forActivities(activityIds: readonly number[]): Promise<Map<number, ActivityFeedback>>;
};

export function createActivityFeedbackStore(db: Database): ActivityFeedbackStore {
  return {
    async set(activityId, fields) {
      const [activity] = await db
        .select({ id: activities.id })
        .from(activities)
        .where(eq(activities.id, activityId));
      if (!activity) return null;
      const [row] = await db
        .insert(activityFeedback)
        .values({ activityId, ...fields })
        .onConflictDoUpdate({
          target: activityFeedback.activityId,
          set: { ...fields, updatedAt: new Date() },
        })
        .returning();
      return row ?? null;
    },

    async get(activityId) {
      const [row] = await db
        .select()
        .from(activityFeedback)
        .where(eq(activityFeedback.activityId, activityId));
      return row ?? null;
    },

    async forActivities(activityIds) {
      if (activityIds.length === 0) return new Map();
      const rows = await db
        .select()
        .from(activityFeedback)
        .where(inArray(activityFeedback.activityId, [...activityIds]));
      return new Map(rows.map((row) => [row.activityId, row]));
    },
  };
}

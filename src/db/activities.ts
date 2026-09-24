import { and, asc, eq, getTableColumns, gte, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { activities } from "./schema.js";

export type Activity = typeof activities.$inferSelect;
// Listing queries skip `raw_data`: the full Strava payload (polyline, splits) is 10-50 KB
// per activity and nothing that lists activities reads it.
export type ActivitySummary = Omit<Activity, "rawData">;
export type NewActivity = typeof activities.$inferInsert;

export type ActivityStore = {
  // ADR-009: upsert on `external_id`. `inserted` is false when the row already existed
  // (a webhook retry or an update event), so callers can skip one-off side effects.
  upsert(activity: NewActivity): Promise<{ activity: Activity; inserted: boolean }>;
  deleteByExternalId(externalId: string): Promise<void>;
  // Activities with `from <= started_at < to`, oldest first.
  between(from: Date, to: Date): Promise<ActivitySummary[]>;
};

export function createActivityStore(db: Database): ActivityStore {
  return {
    async upsert(activity) {
      const { externalId: _key, ...changes } = activity;
      const [row] = await db
        .insert(activities)
        .values(activity)
        .onConflictDoUpdate({
          target: activities.externalId,
          set: { ...changes, updatedAt: new Date() },
        })
        // Postgres sets xmax = 0 only on a freshly inserted row.
        .returning({ ...getTableColumns(activities), inserted: sql<boolean>`(xmax = 0)` });
      if (!row) throw new Error("activity upsert returned no row");
      const { inserted, ...stored } = row;
      return { activity: stored, inserted };
    },

    async deleteByExternalId(externalId) {
      await db.delete(activities).where(eq(activities.externalId, externalId));
    },

    async between(from, to) {
      const { rawData: _raw, ...columns } = getTableColumns(activities);
      return db
        .select(columns)
        .from(activities)
        .where(and(gte(activities.startedAt, from), lt(activities.startedAt, to)))
        .orderBy(asc(activities.startedAt));
    },
  };
}

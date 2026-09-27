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
  // History import: inserts only when the activity isn't stored yet, so a detailed record
  // from the webhook is never replaced by a summary. True when a row was inserted.
  insertMissing(activity: NewActivity): Promise<boolean>;
  deleteByExternalId(externalId: string): Promise<void>;
  // Activities with `from <= started_at < to`, oldest first.
  between(from: Date, to: Date): Promise<ActivitySummary[]>;
  byId(id: number): Promise<ActivitySummary | null>;
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

    async insertMissing(activity) {
      const rows = await db
        .insert(activities)
        .values(activity)
        .onConflictDoNothing({ target: activities.externalId })
        .returning({ id: activities.id });
      return rows.length > 0;
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

    async byId(id) {
      const { rawData: _raw, ...columns } = getTableColumns(activities);
      const [row] = await db.select(columns).from(activities).where(eq(activities.id, id));
      return row ?? null;
    },
  };
}

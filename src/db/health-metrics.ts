import { desc, gte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { healthMetrics } from "./schema.js";

export type HealthMetrics = typeof healthMetrics.$inferSelect;

export type HealthMetricValues = Partial<
  Omit<HealthMetrics, "id" | "date" | "rawData" | "createdAt" | "updatedAt">
>;

export type HealthMetricsUpdate = {
  date: string;
  // Where the values came from; the key under which `raw` is kept in raw_data.
  source: string;
  values: HealthMetricValues;
  raw: unknown;
};

export type HealthMetricsStore = {
  // ADR-009: upsert on `date`. Only the given columns are overwritten, so a record that
  // lacks a value (e.g. no weigh-in that day) never nulls out one stored earlier.
  upsert(update: HealthMetricsUpdate): Promise<void>;
  // Rows on or after `fromDate` (YYYY-MM-DD), newest first.
  since(fromDate: string): Promise<HealthMetrics[]>;
};

export function createHealthMetricsStore(db: Database): HealthMetricsStore {
  return {
    async upsert({ date, source, values, raw }) {
      const defined = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined),
      ) as HealthMetricValues;
      const rawData = { [source]: raw };
      await db
        .insert(healthMetrics)
        .values({ date, ...defined, rawData })
        .onConflictDoUpdate({
          target: healthMetrics.date,
          set: {
            ...defined,
            rawData: sql`${healthMetrics.rawData} || ${JSON.stringify(rawData)}::jsonb`,
            updatedAt: new Date(),
          },
        });
    },

    async since(fromDate) {
      return db
        .select()
        .from(healthMetrics)
        .where(gte(healthMetrics.date, fromDate))
        .orderBy(desc(healthMetrics.date));
    },
  };
}

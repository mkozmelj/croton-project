import { gte, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { llmUsage } from "./schema.js";

export type UsageRecord = typeof llmUsage.$inferInsert;

export type ModelSpend = {
  model: string;
  calls: number;
  costEur: number;
  cacheReadInputTokens: number;
};

export type UsageStore = {
  record(row: UsageRecord): Promise<void>;
  // Total EUR spent on or after `fromDate` (YYYY-MM-DD, local).
  spendSince(fromDate: string): Promise<number>;
  spendByModelSince(fromDate: string): Promise<ModelSpend[]>;
};

export function createUsageStore(db: Database): UsageStore {
  return {
    async record(row) {
      await db.insert(llmUsage).values(row);
    },

    async spendSince(fromDate) {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${llmUsage.costEur}), 0)` })
        .from(llmUsage)
        .where(gte(llmUsage.date, fromDate));
      return Number(row?.total ?? 0);
    },

    async spendByModelSince(fromDate) {
      const rows = await db
        .select({
          model: llmUsage.model,
          calls: sql<string>`count(*)`,
          costEur: sql<string>`sum(${llmUsage.costEur})`,
          cacheReadInputTokens: sql<string>`sum(${llmUsage.cacheReadInputTokens})`,
        })
        .from(llmUsage)
        .where(gte(llmUsage.date, fromDate))
        .groupBy(llmUsage.model)
        .orderBy(llmUsage.model);
      return rows.map((row) => ({
        model: row.model,
        calls: Number(row.calls),
        costEur: Number(row.costEur),
        cacheReadInputTokens: Number(row.cacheReadInputTokens),
      }));
    },
  };
}

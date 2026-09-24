import { eq } from "drizzle-orm";
import { parseWeekPlan, type WeekPlan } from "../training/plan.js";
import type { Database } from "./client.js";
import { trainingPlans } from "./schema.js";

export type StoredPlan = {
  weekStart: string;
  plan: WeekPlan;
  recapNotes: string | null;
  agentAnalysis: string | null;
};

export type SavePlan = {
  plan: WeekPlan;
  recapNotes?: string | null;
  agentAnalysis?: string | null;
};

export type TrainingPlanStore = {
  // The confirmed plan for the week starting `weekStart` (a Monday), if any.
  forWeek(weekStart: string): Promise<StoredPlan | null>;
  // ADR-009: upsert on week_start. Recap fields are only overwritten when given.
  save(plan: SavePlan): Promise<void>;
};

export function createTrainingPlanStore(db: Database): TrainingPlanStore {
  return {
    async forWeek(weekStart) {
      const [row] = await db
        .select()
        .from(trainingPlans)
        .where(eq(trainingPlans.weekStart, weekStart));
      if (!row) return null;
      const plan = parseWeekPlan(row.plan);
      if (!plan) return null;
      return {
        weekStart: row.weekStart,
        plan,
        recapNotes: row.recapNotes,
        agentAnalysis: row.agentAnalysis,
      };
    },

    async save({ plan, recapNotes, agentAnalysis }) {
      const recap = Object.fromEntries(
        Object.entries({ recapNotes, agentAnalysis }).filter(([, value]) => value !== undefined),
      );
      await db
        .insert(trainingPlans)
        .values({ weekStart: plan.week_start, phase: plan.phase, plan, ...recap })
        .onConflictDoUpdate({
          target: trainingPlans.weekStart,
          set: { phase: plan.phase, plan, ...recap, updatedAt: new Date() },
        });
    },
  };
}

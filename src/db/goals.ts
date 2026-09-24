import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import { events, goals } from "./schema.js";

export type Event = typeof events.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type GoalWithEvent = Goal & { event: Event };

export type NewGoal = {
  event: Pick<Event, "name" | "date" | "sport"> & Partial<Pick<Event, "distance" | "location">>;
  goal: Pick<Goal, "season" | "priority" | "goalType"> &
    Partial<Pick<Goal, "target" | "targetSeconds" | "notes">>;
};

export class GoalConflictError extends Error {
  override readonly name = "GoalConflictError";

  constructor(readonly season: number) {
    super(`season ${season} already has an active A goal`);
  }
}

export type GoalStore = {
  // Active goals whose event is on or after `fromDate`, soonest first.
  activeFrom(fromDate: string): Promise<GoalWithEvent[]>;
  // Active goals of any date for these seasons (the A goal can be in the past: transition).
  activeInSeasons(seasons: readonly number[]): Promise<GoalWithEvent[]>;
  // Inserts the event and goal. `replaceGoalId` is set to 'dropped' first (replacing an A goal).
  // Throws GoalConflictError when the one-A-goal-per-season index rejects it.
  create(goal: NewGoal, replaceGoalId?: number): Promise<GoalWithEvent>;
};

// Postgres unique_violation.
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ("code" in error
    ? error.code === "23505"
    : isUniqueViolation((error as { cause?: unknown }).cause));

export function createGoalStore(db: Database): GoalStore {
  // A fresh builder per query: Drizzle builders are mutable.
  const withEvents = () =>
    db
      .select({ goal: goals, event: events })
      .from(goals)
      .innerJoin(events, eq(goals.eventId, events.id));

  const flatten = (rows: { goal: Goal; event: Event }[]) =>
    rows.map(({ goal, event }) => ({ ...goal, event }));

  return {
    async activeFrom(fromDate) {
      const rows = await withEvents()
        .where(and(eq(goals.status, "active"), gte(events.date, fromDate)))
        .orderBy(asc(events.date));
      return flatten(rows);
    },

    async activeInSeasons(seasons) {
      if (seasons.length === 0) return [];
      const rows = await withEvents()
        .where(and(eq(goals.status, "active"), inArray(goals.season, [...seasons])))
        .orderBy(asc(events.date));
      return flatten(rows);
    },

    async create({ event: newEvent, goal: newGoal }, replaceGoalId) {
      // neon-http has no interactive transactions: write in order, undo the event on failure.
      if (replaceGoalId !== undefined) {
        await db
          .update(goals)
          .set({ status: "dropped", updatedAt: new Date() })
          .where(eq(goals.id, replaceGoalId));
      }
      const [event] = await db.insert(events).values(newEvent).returning();
      if (!event) throw new Error("event insert returned no row");
      try {
        const [goal] = await db
          .insert(goals)
          .values({ ...newGoal, eventId: event.id })
          .returning();
        if (!goal) throw new Error("goal insert returned no row");
        return { ...goal, event };
      } catch (error) {
        await db.delete(events).where(eq(events.id, event.id));
        if (isUniqueViolation(error)) throw new GoalConflictError(newGoal.season);
        throw error;
      }
    },
  };
}

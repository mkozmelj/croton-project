import { and, asc, eq, ne, sql } from "drizzle-orm";
import {
  activeMinutes,
  storedWorkoutSchema,
  type WeekHeader,
  type WeekPlan,
  type Workout,
  type WorkoutStatus,
  weekHeaderSchema,
} from "../training/plan.js";
import type { Replacement } from "../training/plan-revisions.js";
import type { Database } from "./client.js";
import { plannedWorkouts, trainingPlans } from "./schema.js";

// ADR-021: a week is its training_plans row (the week-level fields) plus its planned_workouts
// rows that haven't been replaced.

export type StoredPlan = {
  weekStart: string;
  plan: WeekPlan;
  recapNotes: string | null;
  agentAnalysis: string | null;
};

export type NewSession = {
  key: string;
  workout: Workout;
  // The bike leg's key, on a brick's run leg.
  brickWithKey: string | null;
};

export type ApplyWeek = {
  header: WeekHeader;
  // Upserted on `key`: a retry of the same confirmation writes the same rows.
  sessions: NewSession[];
  // The week's earlier sessions this change replaces (plan-revisions.ts).
  replace: Replacement[];
  recapNotes?: string | null;
  agentAnalysis?: string | null;
};

export type TrainingPlanStore = {
  // The confirmed plan for the week starting `weekStart` (a Monday), if any.
  forWeek(weekStart: string): Promise<StoredPlan | null>;
  // One transaction: the week's fields, the new sessions, and the replaced ones. Recap fields
  // are only overwritten when given.
  applyWeek(week: ApplyWeek): Promise<void>;
  // A synced activity fulfilled this session. Moves the activity off any other session.
  setMatch(workoutId: number, activityId: number, status: "done" | "partial"): Promise<void>;
};

type Row = typeof plannedWorkouts.$inferSelect;

export function createTrainingPlanStore(db: Database): TrainingPlanStore {
  const idOfKey = (key: string) =>
    sql`(select ${plannedWorkouts.id} from ${plannedWorkouts} where ${plannedWorkouts.key} = ${key})`;

  return {
    async forWeek(weekStart) {
      const [[header], rows] = await Promise.all([
        db.select().from(trainingPlans).where(eq(trainingPlans.weekStart, weekStart)),
        db
          .select()
          .from(plannedWorkouts)
          .where(
            and(eq(plannedWorkouts.weekStart, weekStart), ne(plannedWorkouts.status, "replaced")),
          )
          .orderBy(asc(plannedWorkouts.date), asc(plannedWorkouts.startTime)),
      ]);
      if (!header) return null;
      const fields = weekHeaderSchema.safeParse(header.plan);
      if (!fields.success) return null;
      return {
        weekStart: header.weekStart,
        plan: { ...fields.data, workouts: rows.flatMap((row) => workoutOf(row) ?? []) },
        recapNotes: header.recapNotes,
        agentAnalysis: header.agentAnalysis,
      };
    },

    async applyWeek({ header, sessions, replace, recapNotes, agentAnalysis }) {
      const recap = Object.fromEntries(
        Object.entries({ recapNotes, agentAnalysis }).filter(([, value]) => value !== undefined),
      );
      const plan = weekHeaderSchema.parse(header);
      const upsertHeader = db
        .insert(trainingPlans)
        .values({ weekStart: plan.week_start, phase: plan.phase, plan, ...recap })
        .onConflictDoUpdate({
          target: trainingPlans.weekStart,
          set: { phase: plan.phase, plan, ...recap, updatedAt: new Date() },
        });
      // Bike legs come before their run legs, so the run leg's subquery finds the bike leg.
      const upserts = sessions.map(({ key, workout, brickWithKey }) => {
        const values = {
          ...rowValues(workout, plan.week_start),
          status: "upcoming" as const,
          statusSource: null,
          replacedBy: null,
          brickWith: brickWithKey ? idOfKey(brickWithKey) : null,
        };
        return db
          .insert(plannedWorkouts)
          .values({ key, ...values })
          .onConflictDoUpdate({
            target: plannedWorkouts.key,
            set: { ...values, updatedAt: new Date() },
          });
      });
      const replacements = replace.map(({ id, status, successorKey }) =>
        db
          .update(plannedWorkouts)
          .set({
            status,
            statusSource: "plan_change",
            replacedBy: successorKey ? idOfKey(successorKey) : null,
            updatedAt: new Date(),
          })
          .where(eq(plannedWorkouts.id, id)),
      );
      await db.batch([upsertHeader, ...upserts, ...replacements]);
    },

    async setMatch(workoutId, activityId, status) {
      await db.batch([
        db
          .update(plannedWorkouts)
          .set({
            activityId: null,
            status: "unconfirmed",
            statusSource: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(plannedWorkouts.activityId, activityId), ne(plannedWorkouts.id, workoutId)),
          ),
        db
          .update(plannedWorkouts)
          .set({ activityId, status, statusSource: "match", updatedAt: new Date() })
          .where(eq(plannedWorkouts.id, workoutId)),
      ]);
    },
  };
}

// The columns a planned session writes. `active_minutes` is always computed (ADR-021).
export function rowValues(workout: Workout, weekStart: string) {
  return {
    weekStart,
    date: workout.date,
    startTime: workout.start_time,
    sport: workout.sport,
    sessionType: workout.session_type,
    title: workout.title,
    intensity: workout.intensity,
    durationMinutes: workout.duration_minutes,
    activeMinutes: activeMinutes(workout),
    structure: workout.structure,
    steps: workout.steps,
    targets: workout.targets,
    fieldTest: workout.field_test,
    notes: workout.notes,
    calendarEventId: workout.calendar_event_id ?? null,
  };
}

// A row as a workout, or null when its stored JSON no longer parses.
export function workoutOf(row: Row): Workout | null {
  const parsed = storedWorkoutSchema.safeParse({
    date: row.date,
    start_time: row.startTime,
    sport: row.sport,
    session_type: row.sessionType,
    title: row.title,
    duration_minutes: row.durationMinutes,
    active_minutes: row.activeMinutes,
    brick_with_previous: row.brickWith !== null,
    intensity: row.intensity,
    structure: row.structure,
    steps: row.steps,
    targets: row.targets,
    field_test: row.fieldTest,
    notes: row.notes,
    calendar_event_id: row.calendarEventId,
  });
  if (!parsed.success) return null;
  const status: WorkoutStatus = row.status;
  return { ...parsed.data, id: row.id, status, activity_id: row.activityId };
}

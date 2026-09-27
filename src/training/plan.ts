import { z } from "zod";
import { addDays, weekStart as mondayOf } from "../utils/dates.js";
import { PHASES } from "./phase.js";

// A week's training plan (spec.md §4.2, flattened to a list of dated workouts). The same
// schema is Claude's structured output for plan generation, the input of the plan-change
// tool, and what training_plans.plan stores. Rest days are days without workouts.

export const PLAN_SPORTS = [
  "run",
  "trail_run",
  "bike",
  "swim",
  "brick",
  "strength",
  "tennis",
  "mobility",
  "other",
] as const;

export const FIELD_TESTS = ["bike_ftp_20min", "run_lthr_30min", "swim_css"] as const;
export type FieldTest = (typeof FIELD_TESTS)[number];

// Kept free of numeric/string-length constraints: structured outputs don't support them
// (the rules are checked in planIssues() instead).
const segmentSchema = z.object({
  segment: z.enum(["warmup", "main", "cooldown"]),
  description: z
    .string()
    .describe("Duration/distance, zone and what to do, e.g. '3x8 min Z4, 3 min Z1 jog between'"),
});

export const workoutSchema = z.object({
  date: z.iso.date().describe("Local date, YYYY-MM-DD, inside the planned week"),
  start_time: z.string().describe("Local start time, HH:MM (24 h)"),
  sport: z.enum(PLAN_SPORTS),
  title: z.string().describe("Short, e.g. 'Tempo intervals' or 'Long run'"),
  duration_minutes: z.number().int(),
  intensity: z.enum(["recovery", "easy", "moderate", "hard", "race"]),
  structure: z.array(segmentSchema),
  targets: z
    .string()
    .nullable()
    .describe("Pace/power/HR targets from the athlete's own zones, or RPE when zones are missing"),
  field_test: z
    .enum(FIELD_TESTS)
    .nullable()
    .describe("Set when this session is a field test from the protocols, else null"),
  notes: z.string().nullable(),
});

export type WorkoutInput = z.infer<typeof workoutSchema>;

export const weekPlanSchema = z.object({
  week_start: z.iso.date().describe("Monday of the planned week"),
  phase: z.enum(PHASES).nullable(),
  focus: z.string().describe("One sentence: the week's purpose"),
  workouts: z.array(workoutSchema),
  weekly_targets: z.object({
    total_hours: z.number(),
    run_km: z.number().nullable(),
    bike_km: z.number().nullable(),
    swim_km: z.number().nullable(),
    easy_percent: z.number().describe("Share of training time in Z1-Z2"),
  }),
});

export type WeekPlanInput = z.infer<typeof weekPlanSchema>;

// Stored workouts also carry their Google Calendar event, once booked, and the Strava
// activity that fulfilled them, once one is matched (plan-match.ts).
export type Workout = WorkoutInput & {
  calendar_event_id?: string | null;
  strava_activity_id?: string | null;
};
export type WeekPlan = Omit<WeekPlanInput, "workouts"> & { workouts: Workout[] };

const storedPlanSchema = weekPlanSchema.extend({
  workouts: z.array(
    workoutSchema.extend({
      calendar_event_id: z.string().nullish(),
      strava_activity_id: z.string().nullish(),
    }),
  ),
});

export function parseWeekPlan(value: unknown): WeekPlan | null {
  const parsed = storedPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Rules the schema can't express. Empty when the plan is usable.
export function planIssues(plan: WeekPlanInput): string[] {
  const issues: string[] = [];
  if (mondayOf(plan.week_start) !== plan.week_start) {
    issues.push(`week_start ${plan.week_start} is not a Monday`);
  }
  const end = addDays(plan.week_start, 6);
  plan.workouts.forEach((workout, index) => {
    const label = `workout ${index + 1} (${workout.title})`;
    if (workout.date < plan.week_start || workout.date > end) {
      issues.push(`${label}: date ${workout.date} is outside ${plan.week_start}..${end}`);
    }
    if (!TIME.test(workout.start_time)) {
      issues.push(`${label}: start_time must be HH:MM, got "${workout.start_time}"`);
    }
    if (workout.duration_minutes < 5 || workout.duration_minutes > 600) {
      issues.push(`${label}: duration_minutes must be 5-600`);
    }
  });
  return issues;
}

// Workouts in date/time order (the model doesn't always list them that way).
export function sortedWorkouts<T extends WorkoutInput>(workouts: readonly T[]): T[] {
  return [...workouts].sort((a, b) =>
    a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date),
  );
}

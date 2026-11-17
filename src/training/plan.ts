import { z } from "zod";
import { addDays, weekStart as mondayOf } from "../utils/dates.js";
import { PHASES } from "./phase.js";
import {
  isBrickType,
  SESSION_TYPE_GUIDE,
  SESSION_TYPES,
  sessionTypeFits,
} from "./session-types.js";

// A week's training plan, as a list of dated workouts. The same schema is Claude's structured
// output for plan generation and the input of the plan-change tool. Since ADR-021 each workout
// is stored as a planned_workouts row and training_plans.plan keeps the week-level fields.
// Rest days are days without workouts.

// A brick is planned as two workouts, a bike leg and a run leg (ADR-021).
export const PLAN_SPORTS = [
  "run",
  "trail_run",
  "bike",
  "swim",
  "strength",
  "tennis",
  "mobility",
  "other",
] as const;

// Stored sessions from before ADR-021 can still be one 'brick' workout.
export const STORED_SPORTS = [...PLAN_SPORTS, "brick"] as const;
export type StoredSport = (typeof STORED_SPORTS)[number];

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

// ADR-020: the watch workout, sent to Intervals.icu (and from there to Garmin Connect). Targets
// are absolute values read off the athlete's zones; code converts them to Intervals.icu's syntax.
const stepTargetSchema = z.object({
  metric: z.enum(["power", "hr", "pace"]),
  min: z.number().describe("Lower number of the range: W, bpm, or pace in seconds"),
  max: z.number().describe("Upper number of the range (same as min for a single value)"),
});

export const STEP_INTENSITIES = ["warmup", "active", "recovery", "rest", "cooldown"] as const;

const stepFields = {
  label: z
    .string()
    .describe(
      "Short cue shown on the watch, words only (no numbers), e.g. 'Warm-up', 'Drill', 'Tempo'",
    ),
  duration_seconds: z
    .number()
    .int()
    .nullable()
    .describe("Set this or distance_meters, not both (a distance wins)"),
  distance_meters: z.number().nullable(),
  target: stepTargetSchema
    .nullable()
    .describe(
      "From the athlete's zones: power in W, hr in bpm, pace in seconds per km (run) or per 100 m (swim). null for rest and other untargeted steps",
    ),
};

const intensitySchema = z
  .enum(STEP_INTENSITIES)
  .describe(
    "warmup / cooldown for those steps; active for work; recovery for easy moving recovery (jog, easy spin); rest for standing or wall rest: duration only, no target",
  );

const stepSchema = z.object({ ...stepFields, intensity: intensitySchema });

const stepBlockSchema = z.object({
  repeat: z.number().int().describe("How many times the steps run in a row; 1 for once"),
  steps: z.array(stepSchema),
});

export type StepBlock = z.infer<typeof stepBlockSchema>;
export type Step = z.infer<typeof stepSchema>;

const STEPS_DESCRIPTION =
  "The session as a watch workout, for run, trail_run, bike and swim sessions; null for other sports. Blocks in order, e.g. warm-up (repeat 1), intervals with their recoveries (repeat 4), cool-down (repeat 1). It must match structure and add up to about duration_minutes. Swims: a rest step after the warm-up, as the last step inside every repeat, between sets, and before the cool-down";

const stepsSchema = z.array(stepBlockSchema).nullable().describe(STEPS_DESCRIPTION);

// Plans stored before ADR-020 have no steps, and steps stored before the intensity field
// count as work.
const storedStepsSchema = z
  .array(
    z.object({
      repeat: z.number().int(),
      steps: z.array(
        z.object({ ...stepFields, intensity: z.enum(STEP_INTENSITIES).default("active") }),
      ),
    }),
  )
  .nullable()
  .default(null);

// Steps planned before the intensity field were stored as "active", wall rests included. For
// the ADR-021 switchover: a timed, untargeted step labelled "Rest" was a rest.
export function withLegacyRests<T extends Pick<WorkoutInput, "steps">>(workout: T): T {
  if (!workout.steps) return workout;
  return {
    ...workout,
    steps: workout.steps.map((block) => ({
      ...block,
      steps: block.steps.map((step) =>
        step.intensity === "active" &&
        /^rest\b/i.test(step.label.trim()) &&
        !step.distance_meters &&
        !step.target
          ? { ...step, intensity: "rest" as const }
          : step,
      ),
    })),
  };
}

export const workoutSchema = z.object({
  date: z.iso.date().describe("Local date, YYYY-MM-DD, inside the planned week"),
  start_time: z.string().describe("Local start time, HH:MM (24 h)"),
  sport: z.enum(PLAN_SPORTS),
  session_type: z
    .enum(SESSION_TYPES)
    .describe(
      `The session's family, so it can be progressed from its last occurrence: ${SESSION_TYPE_GUIDE}`,
    ),
  title: z.string().describe("Short, e.g. 'Tempo intervals' or 'Long run'"),
  duration_minutes: z.number().int().describe("The whole session including rest, for the calendar"),
  active_minutes: z
    .number()
    .int()
    .describe(
      "Moving time without rest (wall rest in a swim, rest between strength sets); same as duration_minutes when the session has no standing rest",
    ),
  brick_with_previous: z
    .boolean()
    .describe(
      "true only on the run leg of a brick, planned right after its bike leg (both legs get the same brick_* session_type)",
    ),
  intensity: z.enum(["recovery", "easy", "moderate", "hard", "race"]),
  structure: z.array(segmentSchema),
  steps: stepsSchema,
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

// The week-level fields training_plans.plan keeps since ADR-021 (sessions are rows).
export const weekHeaderSchema = weekPlanSchema.omit({ workouts: true });
export type WeekHeader = z.infer<typeof weekHeaderSchema>;

// A workout held in a pending proposal or stored before ADR-021: older ones have no steps,
// session type, active minutes or brick legs ('brick' was one session then).
export const storedWorkoutSchema = workoutSchema.extend({
  sport: z.enum(STORED_SPORTS),
  steps: storedStepsSchema,
  session_type: z.enum(SESSION_TYPES).default("other"),
  active_minutes: z.number().int().optional(),
  brick_with_previous: z.boolean().default(false),
  calendar_event_id: z.string().nullish(),
});

export type WorkoutInput = z.output<typeof storedWorkoutSchema>;

export const WORKOUT_STATUSES = [
  "upcoming",
  "done",
  "partial",
  "unconfirmed",
  "skipped",
  "replaced",
] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number];

export const STATUS_SOURCES = ["match", "athlete", "timeout", "plan_change", "backfill"] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

// A stored session (ADR-021) carries its row id, status and the activity that fulfilled it.
// Sessions still in a proposal have none of these.
export type Workout = WorkoutInput & {
  id?: number;
  status?: WorkoutStatus;
  activity_id?: number | null;
};
export type WeekPlan = Omit<WeekPlanInput, "workouts"> & { workouts: Workout[] };

export const storedPlanSchema = weekPlanSchema.extend({ workouts: z.array(storedWorkoutSchema) });

// Sports where the model's active_minutes is used as given: their rest isn't in the steps.
const OWN_ACTIVE_TIME = new Set(["swim", "strength", "mobility"]);

// ADR-021: the minutes Strava's moving time is compared with. With steps, the rest steps come
// off the whole duration; swims, strength and mobility without steps use the model's number.
export function activeMinutes(
  workout: Pick<WorkoutInput, "sport" | "duration_minutes" | "active_minutes" | "steps">,
): number {
  const total = workout.duration_minutes;
  const clamp = (minutes: number) => Math.min(total, Math.max(1, Math.round(minutes)));
  if (workout.steps && workout.steps.length > 0) {
    const rest = workout.steps.reduce(
      (sum, block) =>
        sum +
        block.repeat *
          block.steps.reduce(
            (s, step) =>
              s +
              (step.intensity === "rest" && !step.distance_meters
                ? (step.duration_seconds ?? 0)
                : 0),
            0,
          ),
      0,
    );
    return clamp(total - rest / 60);
  }
  if (OWN_ACTIVE_TIME.has(workout.sport)) return clamp(workout.active_minutes ?? total);
  return total;
}

// ADR-021 v1 status of a matched session, by duration only: 80% of the active minutes or more
// is done, less is partial (plan-match.ts already rejects under 40%). A legacy brick row
// covers two activities, so either one completes it.
export function completionStatus(
  workout: Pick<WorkoutInput, "sport" | "duration_minutes" | "active_minutes" | "steps">,
  durationSeconds: number,
): "done" | "partial" {
  if (workout.sport === "brick") return "done";
  return durationSeconds / 60 >= 0.8 * activeMinutes(workout) ? "done" : "partial";
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Rules the schema can't express, per workout (same order as plan.workouts).
export function workoutIssues(plan: WeekPlanInput): string[][] {
  const end = addDays(plan.week_start, 6);
  const issues = plan.workouts.map((workout, index) => {
    const label = `workout ${index + 1} (${workout.title})`;
    const found: string[] = [];
    if (workout.date < plan.week_start || workout.date > end) {
      found.push(`${label}: date ${workout.date} is outside ${plan.week_start}..${end}`);
    }
    if (!TIME.test(workout.start_time)) {
      found.push(`${label}: start_time must be HH:MM, got "${workout.start_time}"`);
    }
    if (workout.duration_minutes < 5 || workout.duration_minutes > 600) {
      found.push(`${label}: duration_minutes must be 5-600`);
    }
    if (workout.active_minutes > workout.duration_minutes) {
      found.push(`${label}: active_minutes can't exceed duration_minutes`);
    }
    if (!sessionTypeFits(workout.session_type, workout.sport)) {
      found.push(
        `${label}: session_type ${workout.session_type} doesn't fit sport ${workout.sport}`,
      );
    }
    if ((workout.session_type === "field_test") !== (workout.field_test !== null)) {
      found.push(`${label}: use session_type field_test exactly when field_test is set`);
    }
    return found;
  });

  // Bricks are two workouts: a bike leg, then a run leg with brick_with_previous.
  const order = plan.workouts
    .map((workout, index) => ({ workout, index }))
    .sort((a, b) => compareTime(a.workout, b.workout));
  order.forEach(({ workout, index }, position) => {
    const label = `workout ${index + 1} (${workout.title})`;
    const before = order[position - 1]?.workout;
    const after = order[position + 1]?.workout;
    if (workout.brick_with_previous) {
      const legs =
        before !== undefined &&
        before.date === workout.date &&
        before.sport === "bike" &&
        (workout.sport === "run" || workout.sport === "trail_run") &&
        isBrickType(workout.session_type) &&
        before.session_type === workout.session_type;
      if (!legs) {
        issues[index]?.push(
          `${label}: brick_with_previous needs a run leg right after a bike leg on the same day, both with the same brick_* session_type`,
        );
      }
    } else if (isBrickType(workout.session_type)) {
      const runLegFollows =
        workout.sport === "bike" &&
        after?.brick_with_previous === true &&
        after.session_type === workout.session_type;
      if (!runLegFollows) {
        issues[index]?.push(
          `${label}: a ${workout.session_type} session is a bike leg followed by a run leg with brick_with_previous`,
        );
      }
    }
  });
  return issues;
}

// Empty when the plan is usable.
export function planIssues(plan: WeekPlanInput): string[] {
  const week =
    mondayOf(plan.week_start) !== plan.week_start
      ? [`week_start ${plan.week_start} is not a Monday`]
      : [];
  return [...week, ...workoutIssues(plan).flat()];
}

// The plan without its unusable workouts (and without the other leg of a brick that lost one),
// with the reasons for what was dropped.
export function withoutInvalidWorkouts(plan: WeekPlanInput): {
  plan: WeekPlanInput;
  dropped: string[];
} {
  let current = plan;
  const dropped: string[] = [];
  for (;;) {
    const issues = workoutIssues(current);
    if (issues.every((found) => found.length === 0)) return { plan: current, dropped };
    dropped.push(...issues.flat());
    current = { ...current, workouts: current.workouts.filter((_, i) => issues[i]?.length === 0) };
  }
}

function compareTime(a: Pick<WorkoutInput, "date" | "start_time">, b: typeof a): number {
  return a.date === b.date
    ? a.start_time.localeCompare(b.start_time)
    : a.date.localeCompare(b.date);
}

// The first stored plans sometimes wrote a rest day as a session ("Rest - travel day"). It
// isn't a session to complete, so the ADR-021 switchover leaves it out.
export function isRestDayEntry(workout: Pick<WorkoutInput, "sport" | "title">): boolean {
  return workout.sport === "other" && /^rest\b/i.test(workout.title.trim());
}

// Workouts in date/time order (the model doesn't always list them that way).
export function sortedWorkouts<T extends Pick<WorkoutInput, "date" | "start_time">>(
  workouts: readonly T[],
): T[] {
  return [...workouts].sort(compareTime);
}

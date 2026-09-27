import type { WeekPlan, Workout, WorkoutInput } from "../training/plan.js";
import { sortedWorkouts } from "../training/plan.js";

// Plain-text renderings of plans, shared by the prompt context and Telegram (like
// activity-format.ts). Plan text written by the model is data: it's rendered, not obeyed.

export const dayLabel = (isoDate: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${isoDate}T00:00:00Z`));

// One line, e.g. `Tue 29 Sep 07:00 run "Tempo intervals", 55 min, hard, targets 4:15 /km`.
export function workoutLine(workout: WorkoutInput): string {
  const parts = [
    `${dayLabel(workout.date)} ${workout.start_time} ${workout.sport} ${JSON.stringify(workout.title)}`,
    `${workout.duration_minutes} min`,
    workout.intensity,
  ];
  if (workout.field_test) parts.push(`FIELD TEST ${workout.field_test}`);
  if (workout.targets) parts.push(`targets ${workout.targets}`);
  return parts.join(", ");
}

// Several lines per workout, for Telegram.
export function workoutDetail(workout: Workout): string {
  const lines = [workoutLine(workout)];
  for (const segment of workout.structure)
    lines.push(`  ${segment.segment}: ${segment.description}`);
  if (workout.notes) lines.push(`  ${workout.notes}`);
  return lines.join("\n");
}

function targetsLine(plan: WeekPlan): string {
  const t = plan.weekly_targets;
  const parts = [`${t.total_hours} h`];
  if (t.run_km) parts.push(`run ${t.run_km} km`);
  if (t.bike_km) parts.push(`bike ${t.bike_km} km`);
  if (t.swim_km) parts.push(`swim ${t.swim_km} km`);
  parts.push(`${Math.round(t.easy_percent)}% easy`);
  return parts.join(", ");
}

export function planHeader(plan: WeekPlan): string {
  const phase = plan.phase ? `, ${plan.phase} phase` : "";
  return `Week of Mon ${plan.week_start}${phase}: ${plan.focus}\nTargets: ${targetsLine(plan)}`;
}

// Full plan for Telegram: header, then each workout with its structure.
export function planText(plan: WeekPlan): string {
  const workouts = sortedWorkouts(plan.workouts);
  return [
    planHeader(plan),
    "",
    ...(workouts.length > 0 ? workouts.map(workoutDetail) : ["No sessions planned."]),
  ].join("\n");
}

// Compact plan for the prompt context: one line per workout.
export function planLines(plan: WeekPlan): string[] {
  return [
    planHeader(plan).replace("\n", ". "),
    ...sortedWorkouts(plan.workouts).map((w) => `- ${workoutLine(w)}`),
  ];
}

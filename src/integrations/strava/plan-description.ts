import type { WeekPlan, Workout } from "../../training/plan.js";

// The block a matched Strava activity gets in its description: what was planned and how the
// session compared. Strava descriptions are plain text and usually public, so this holds
// plan and compliance only, never wellness data (HRV, sleep, weight) or the coach's comment.

// Our block always starts with this line and runs to the end of the description, so a rerun
// replaces it instead of adding a second one.
export const PLAN_BLOCK_START = "📋 Planned:";

const SEGMENT_LABELS: Record<Workout["structure"][number]["segment"], string> = {
  warmup: "Warm-up",
  main: "Main",
  cooldown: "Cool-down",
};

const FIELD_TEST_LABELS: Record<NonNullable<Workout["field_test"]>, string> = {
  bike_ftp_20min: "20-min FTP test",
  run_lthr_30min: "30-min run LTHR test",
  swim_css: "CSS swim test",
};

type BlockInput = {
  workout: Workout;
  plan: Pick<WeekPlan, "phase" | "workouts">;
  movingSeconds: number;
};

export function planBlock({ workout, plan, movingSeconds }: BlockInput): string {
  const lines = [
    `${PLAN_BLOCK_START} ${workout.title} · ${workout.duration_minutes} min · ${workout.intensity}`,
    ...workout.structure.map((s) => `${SEGMENT_LABELS[s.segment]}: ${s.description}`),
  ];
  if (workout.targets) lines.push(`🎯 Targets: ${workout.targets}`);
  if (workout.field_test) lines.push(`🧪 ${FIELD_TEST_LABELS[workout.field_test]}`);

  const done = Math.round(movingSeconds / 60);
  // A brick's plan entry covers both activities, so a share of it would mislead.
  if (workout.sport !== "brick" && workout.duration_minutes > 0) {
    const percent = Math.round((done / workout.duration_minutes) * 100);
    lines.push(`✅ Done: ${done} of ${workout.duration_minutes} min (${percent}%)`);
  }

  const index = plan.workouts.indexOf(workout);
  const week = [
    ...(index >= 0 ? [`Session ${index + 1} of ${plan.workouts.length} this week`] : []),
    ...(plan.phase ? [`${capitalize(plan.phase)} phase`] : []),
  ];
  if (week.length > 0) lines.push(`📆 ${week.join(" · ")}`);
  lines.push("— Croton coach");
  return lines.join("\n");
}

// The athlete's (or device's) own text stays first; an earlier block of ours is replaced.
export function withPlanBlock(existing: string | null, block: string): string {
  const own = (existing ?? "").split(PLAN_BLOCK_START)[0]?.trimEnd() ?? "";
  return own ? `${own}\n\n${block}` : block;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

import { formatKm, formatPace } from "../../agent/activity-format.js";
import type { Activity } from "../../db/activities.js";
import type { Workout } from "../../training/plan.js";

// The block a matched Strava activity gets in its description: a short plain-text
// comparison of what was done and what was planned. Strava descriptions are usually public,
// so this holds plan and compliance only, never wellness data (HRV, sleep, weight) or the
// coach's comment. No emojis, only the lines that matter for this session.

// Our block always starts with this line and runs to the end of the description, so a rerun
// replaces it instead of adding a second one.
export const PLAN_BLOCK_START = "Plan:";
// The first version of the block, still found on older activities.
const LEGACY_BLOCK_START = "\u{1F4CB} Planned:";

const FIELD_TEST_LABELS: Record<NonNullable<Workout["field_test"]>, string> = {
  bike_ftp_20min: "20-min FTP test",
  run_lthr_30min: "30-min run LTHR test",
  swim_css: "CSS swim test",
};

type BlockInput = {
  workout: Workout;
  activity: Pick<
    Activity,
    "durationSeconds" | "distanceMeters" | "avgHr" | "avgPacePerKm" | "avgPower"
  >;
};

export function planBlock({ workout, activity }: BlockInput): string {
  const lines = [`${PLAN_BLOCK_START} ${workout.title} (${workout.intensity})`];

  const done = Math.round(activity.durationSeconds / 60);
  // A brick's plan entry covers both activities, so a comparison would mislead.
  lines.push(
    workout.sport === "brick" || workout.duration_minutes <= 0
      ? `Duration: ${done} min`
      : `Duration: ${done} / ${workout.duration_minutes} min`,
  );
  if (activity.distanceMeters) lines.push(`Distance: ${formatKm(activity.distanceMeters)}`);
  if (activity.avgPacePerKm) lines.push(`Avg pace: ${formatPace(activity.avgPacePerKm)}`);
  if (activity.avgPower) lines.push(`Avg power: ${Math.round(activity.avgPower)} W`);
  if (activity.avgHr) lines.push(`Avg HR: ${activity.avgHr} bpm`);

  if (workout.targets) lines.push(`Target: ${workout.targets}`);
  const main = workout.structure.find((s) => s.segment === "main");
  if (main) lines.push(`Main set: ${main.description}`);
  if (workout.field_test) lines.push(`Test: ${FIELD_TEST_LABELS[workout.field_test]}`);
  return lines.join("\n");
}

// The athlete's (or device's) own text stays first; an earlier block of ours is replaced.
export function withPlanBlock(existing: string | null, block: string): string {
  const text = existing ?? "";
  const found = new RegExp(`(^|\\n)(${PLAN_BLOCK_START}|${LEGACY_BLOCK_START})`).exec(text);
  const own = (found ? text.slice(0, found.index) : text).trimEnd();
  return own ? `${own}\n\n${block}` : block;
}

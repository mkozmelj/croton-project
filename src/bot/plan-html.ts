import { dayLabel } from "../agent/plan-format.js";
import type { FieldTest, WeekPlan, Workout, WorkoutInput } from "../training/plan.js";
import { sortedWorkouts } from "../training/plan.js";
import { addDays } from "../utils/dates.js";
import { bold, esc, intensityEmoji, italic, quote, sportEmoji } from "./html.js";

// Telegram renderings of plans (ADR-017). The plain ones in agent/plan-format.ts stay for the
// prompt context and stored conversations. Titles, targets and notes are model-written: they
// are escaped like any other data.

const FIELD_TEST_NAMES: Record<FieldTest, string> = {
  bike_ftp_20min: "20-min FTP test",
  run_lthr_30min: "30-min threshold run test",
  swim_css: "CSS swim test",
};

const SEGMENT_NAMES: Record<Workout["structure"][number]["segment"], string> = {
  warmup: "Warm-up",
  main: "Main set",
  cooldown: "Cool-down",
};

// Title line and key facts, e.g. "🏃 07:00 Tempo intervals" / "55 min · 🔴 hard · 4:15 /km".
function workoutHead(workout: WorkoutInput): string[] {
  const facts = [
    `${workout.duration_minutes} min`,
    `${intensityEmoji(workout.intensity)} ${workout.intensity}`,
  ];
  if (workout.targets) facts.push(esc(workout.targets));
  const lines = [
    `${sportEmoji(workout.sport)} <b>${esc(workout.start_time)} ${esc(workout.title)}</b>`,
    facts.join(" · "),
  ];
  if (workout.field_test)
    lines.push(`🧪 <b>Field test:</b> ${FIELD_TEST_NAMES[workout.field_test]}`);
  return lines;
}

function workoutBody(workout: WorkoutInput): string {
  const lines = workout.structure.map(
    (s) => `<b>${SEGMENT_NAMES[s.segment]}:</b> ${esc(s.description)}`,
  );
  if (workout.notes) lines.push(`📝 ${esc(workout.notes)}`);
  return lines.join("\n");
}

// One session in full, for /tomorrow: the structure is the point, so it's shown open.
export function workoutHtml(workout: WorkoutInput): string {
  const body = workoutBody(workout);
  return [...workoutHead(workout), ...(body ? [quote(body)] : [])].join("\n");
}

function targetsLine(plan: WeekPlan): string {
  const t = plan.weekly_targets;
  const parts = [`⏱️ ${t.total_hours} h`];
  if (t.run_km) parts.push(`${sportEmoji("run")} ${t.run_km} km`);
  if (t.bike_km) parts.push(`${sportEmoji("bike")} ${t.bike_km} km`);
  if (t.swim_km) parts.push(`${sportEmoji("swim")} ${t.swim_km} km`);
  parts.push(`${Math.round(t.easy_percent)}% easy`);
  return parts.join(" · ");
}

// The week grouped by day, each session's structure folded into an expandable quote. Days
// without sessions show as rest from the first planned day on (a re-plan mid-week leaves the
// days already past out).
export function planHtml(plan: WeekPlan): string {
  const workouts = sortedWorkouts(plan.workouts);
  const phase = plan.phase ? ` · ${esc(plan.phase)} phase` : "";
  const header = [
    `📅 <b>Week of ${esc(dayLabel(plan.week_start))}</b>${phase}`,
    italic(plan.focus),
    targetsLine(plan),
  ].join("\n");
  const first = workouts[0]?.date;
  if (!first) return `${header}\n\nNo sessions planned.`;

  const days: string[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(plan.week_start, offset);
    if (date < first) continue;
    const sessions = workouts.filter((w) => w.date === date);
    if (sessions.length === 0) {
      days.push(`${bold(dayLabel(date))} · 💤 rest`);
      continue;
    }
    const blocks = sessions.map((w) => {
      const body = workoutBody(w);
      return [...workoutHead(w), ...(body ? [quote(body, true)] : [])].join("\n");
    });
    days.push([bold(dayLabel(date)), blocks.join("\n\n")].join("\n"));
  }
  return [header, ...days].join("\n\n");
}

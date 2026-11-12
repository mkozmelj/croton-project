import type { Step, StepBlock, Workout } from "../../training/plan.js";
import type { NewWorkoutEvent, SportSettings } from "./client.js";

// ADR-020: planned sessions become Intervals.icu workouts, which Intervals.icu sends to Garmin
// Connect. The syntax below was checked against real parses (`workout_doc`) on 2026-11-12:
// `- Tempo 1km 4:50-5:00/km Pace`, `- 8m 235-250w`, `- 300mtr 2:05-2:15/100m Pace`,
// `- 5m 85.5-90.2% LTHR`, and a `4x` line opening a repeat block. Absolute bpm isn't parsed
// at all, so heart rate goes as % of the LTHR Intervals.icu holds for that sport. A trailing
// `intensity=rest` (or warmup, active, recovery, cooldown) sets the step's intensity in the
// workout Garmin gets (checked in the FIT download, 2026-11-13). Without it every step is plain
// work, and a timed rest in a pool swim shows on the watch as a swim with no distance.

// Plan sport → Intervals.icu activity type. Other sports aren't sent: a watch workout adds
// nothing to strength, tennis or mobility, and a brick is two sports in one session.
export const WATCH_SPORTS: Partial<Record<Workout["sport"], string>> = {
  run: "Run",
  trail_run: "Run", // a running workout on the watch either way
  bike: "Ride",
  swim: "Swim",
};

// Every event the bot creates carries this prefix, so a plan change can find and replace them.
export const EXTERNAL_ID_PREFIX = "croton:";

export function watchExternalId(bookingKey: string, index: number): string {
  return `${EXTERNAL_ID_PREFIX}${bookingKey}:${index}`;
}

const MAX_REPEAT = 50;

// Rules the step schema can't express. Empty when the steps can be sent.
export function stepIssues(blocks: readonly StepBlock[]): string[] {
  const issues: string[] = [];
  if (blocks.length === 0) issues.push("no steps");
  blocks.forEach((block, b) => {
    const where = `block ${b + 1}`;
    if (!Number.isInteger(block.repeat) || block.repeat < 1 || block.repeat > MAX_REPEAT) {
      issues.push(`${where}: repeat must be 1-${MAX_REPEAT}`);
    }
    if (block.steps.length === 0) issues.push(`${where}: no steps`);
    block.steps.forEach((step, s) => {
      const at = `${where} step ${s + 1}`;
      const hasDuration = step.duration_seconds !== null;
      const hasDistance = step.distance_meters !== null;
      // Both set is fine: the distance wins (the duration is then only an estimate).
      if (!hasDuration && !hasDistance) issues.push(`${at}: no duration or distance`);
      if (hasDuration && !((step.duration_seconds ?? 0) > 0)) issues.push(`${at}: duration ≤ 0`);
      if (hasDistance && !((step.distance_meters ?? 0) > 0)) issues.push(`${at}: distance ≤ 0`);
      if (step.target && !(step.target.min > 0 && step.target.max > 0)) {
        issues.push(`${at}: target must be positive`);
      }
    });
  });
  return issues;
}

// 3930 → "1h5m30s"
export function durationText(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s || seconds === 0 ? `${s}s` : ""}`;
}

// "m" means minutes in Intervals.icu's syntax; metres are "mtr".
export function distanceText(meters: number): string {
  const rounded = Math.round(meters);
  return rounded >= 1000 && rounded % 100 === 0 ? `${rounded / 1000}km` : `${rounded}mtr`;
}

function clock(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

function range(min: number, max: number, show: (value: number) => string): string {
  const [low, high] = min <= max ? [min, max] : [max, min];
  return show(low) === show(high) ? show(low) : `${show(low)}-${show(high)}`;
}

// The target in Intervals.icu's syntax, or null when it can't be expressed (heart rate
// without an LTHR, pace on the bike). The step is still sent, untargeted.
export function targetText(
  target: NonNullable<Step["target"]>,
  sport: Workout["sport"],
  lthr: number | null,
): string | null {
  switch (target.metric) {
    case "power":
      return `${range(target.min, target.max, (w) => String(Math.round(w)))}w`;
    case "hr":
      if (!lthr) return null;
      return `${range(target.min, target.max, (bpm) => String(oneDecimal((bpm / lthr) * 100)))}% LTHR`;
    case "pace": {
      if (sport === "bike") return null;
      const unit = sport === "swim" ? "/100m" : "/km";
      return `${range(target.min, target.max, clock)}${unit} Pace`;
    }
  }
}

// Words only: digits or a leading dash would be read as a duration, target or step marker.
// Whole words with digits or symbols go ("Drill 50m" → "Drill", not "Drill m").
export function stepLabel(label: string): string {
  return label
    .split(/\s+/)
    .filter((word) => /^[\p{L}'-]+$/u.test(word))
    .join(" ")
    .replace(/^[\s'-]+/, "")
    .slice(0, 30)
    .trim();
}

function stepLine(step: Step, sport: Workout["sport"], lthr: number | null): string {
  const amount =
    step.distance_meters !== null
      ? distanceText(step.distance_meters)
      : durationText(step.duration_seconds ?? 0);
  // A rest is untargeted whatever the plan says.
  const target =
    step.target && step.intensity !== "rest" ? targetText(step.target, sport, lthr) : null;
  return ["-", stepLabel(step.label), amount, target, `intensity=${step.intensity}`]
    .filter(Boolean)
    .join(" ");
}

// The workout as Intervals.icu workout text, or null when it has no usable steps.
export function workoutText(workout: Workout, lthr: number | null): string | null {
  if (!workout.steps || stepIssues(workout.steps).length > 0) return null;
  const lines: string[] = [];
  for (const block of workout.steps) {
    const steps = block.steps.map((step) => stepLine(step, workout.sport, lthr));
    // A repeat block is a "Nx" line followed by its steps, with a blank line on both sides.
    if (block.repeat > 1) lines.push("", `${block.repeat}x`, ...steps, "");
    else lines.push(...steps);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The LTHR Intervals.icu holds for an activity type: it converts "% LTHR" back to bpm with it.
export function lthrFor(settings: readonly SportSettings[], type: string): number | null {
  return settings.find((s) => s.types.includes(type))?.lthr ?? null;
}

// The Intervals.icu event for a planned workout, or null when it isn't a watch workout.
export function workoutEvent(
  workout: Workout,
  { externalId, settings }: { externalId: string; settings: readonly SportSettings[] },
): NewWorkoutEvent | null {
  const type = WATCH_SPORTS[workout.sport];
  if (!type) return null;
  const description = workoutText(workout, lthrFor(settings, type));
  if (!description) return null;
  return {
    category: "WORKOUT",
    type,
    name: workout.title,
    start_date_local: `${workout.date}T${workout.start_time}:00`,
    description,
    moving_time: workout.duration_minutes * 60,
    external_id: externalId,
  };
}

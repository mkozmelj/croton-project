import { localDate, localMidnight } from "../utils/dates.js";
import type { Workout } from "./plan.js";

// Which planned workout a synced activity fulfilled. Used for the feedback questions
// (ADR-018) and to give the Strava activity the planned session's title and description.

// Plan sports that a synced activity of this sport can fulfil, best fit first.
const PLAN_SPORTS_FOR: Record<string, readonly string[]> = {
  run: ["run", "trail_run", "brick"],
  trail_run: ["trail_run", "run", "brick"],
  bike: ["bike", "brick"],
};

// Outside this share of the planned duration it was a different session (a 15-minute jog
// on a long-run day, a commute ride on a bike-intervals day).
const MIN_DURATION_SHARE = 0.4;
const MAX_DURATION_SHARE = 2.5;

export type MatchableActivity = {
  externalId: string;
  sport: string;
  startedAt: Date;
  durationSeconds: number;
};

// The planned workout this activity most likely was: same local day, a matching sport and a
// plausible duration, not already fulfilled by another activity. Among several, the one it
// was already matched to wins, then the closer sport, then the closer start time.
export function matchPlannedWorkout<T extends Workout>(
  activity: MatchableActivity,
  workouts: readonly T[],
  timeZone: string,
): T | undefined {
  const day = localDate(activity.startedAt, timeZone);
  const sports = PLAN_SPORTS_FOR[activity.sport] ?? [activity.sport];
  const startMinute =
    (activity.startedAt.getTime() - localMidnight(day, timeZone).getTime()) / 60_000;

  const scored = workouts.flatMap((workout) => {
    if (workout.date !== day || !sports.includes(workout.sport)) return [];
    const linked = workout.strava_activity_id ?? null;
    if (linked !== null && linked !== activity.externalId) return [];
    if (!plausibleDuration(workout, activity.durationSeconds)) return [];
    return [
      {
        workout,
        rank: [
          linked === activity.externalId ? 0 : 1,
          sports.indexOf(workout.sport),
          Math.abs(minuteOfDay(workout.start_time) - startMinute),
        ],
      },
    ];
  });
  scored.sort((a, b) => compareRanks(a.rank, b.rank));
  return scored[0]?.workout;
}

function plausibleDuration(workout: Workout, durationSeconds: number): boolean {
  // A brick is one plan entry for two activities, so either part is shorter than planned.
  if (workout.sport === "brick" || workout.duration_minutes <= 0) return true;
  const share = durationSeconds / 60 / workout.duration_minutes;
  return share >= MIN_DURATION_SHARE && share <= MAX_DURATION_SHARE;
}

function minuteOfDay(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

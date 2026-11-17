import { createHash } from "node:crypto";
import type { ActivitySummary, NewActivity } from "../../db/activities.js";
import { STORED_SPORTS, type StoredSport, type Workout } from "../../training/plan.js";
import { fallbackSessionType } from "../../training/session-types.js";
import { addDays, localDate, localMidnight, weekStart } from "../../utils/dates.js";
import type { TpWorkout } from "./workouts.js";

// TrainingPeaks workouts → `activities` rows (source 'trainingpeaks_import') and a Markdown
// digest of the plan for the literature corpus (ADR-014).

const SPORTS: Record<string, string> = {
  swim: "swim",
  bike: "bike",
  mountainbike: "bike",
  mtb: "bike",
  run: "run",
  strength: "strength",
  walk: "walk",
  brick: "brick",
  xcski: "xc_ski",
  rowing: "rowing",
  crosstrain: "crosstrain",
};
const PACE_SPORTS = new Set(["run", "walk"]);

// Generic types ("Other", "Walk", "Brick") often carry the real sport in the title, as the
// device's activity name: "Tennis", "Hiking", "Road Cycling".
const GENERIC_TYPES = new Set(["other", "walk", "brick", "custom", ""]);
const TITLE_SPORTS: [RegExp, string][] = [
  [/\btennis\b/i, "tennis"],
  [/\bhik(e|ing)\b/i, "hike"],
  [/\bkayak/i, "kayaking"],
  [/\bmobility\b/i, "mobility"],
  [/\btransition\b/i, "transition"],
  [/\b(road|gravel) cycling\b|\bmountain biking\b/i, "bike"],
];

export function sportFromTrainingPeaks(type: string | null, title: string | null = null): string {
  const key = (type ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (GENERIC_TYPES.has(key) && title) {
    const match = TITLE_SPORTS.find(([pattern]) => pattern.test(title));
    if (match) return match[1];
  }
  return SPORTS[key] ?? (key || "other");
}

const isDayOff = (w: TpWorkout) => (w.type ?? "").toLowerCase().replace(/\s/g, "") === "dayoff";
export const isCompleted = (w: TpWorkout) => !isDayOff(w) && (w.hours ?? 0) > 0;

// The export has no stable workout id. The key is built from what identifies the workout, so
// re-importing the same file upserts the same rows (ADR-009); `occurrence` separates exact
// duplicates on one day.
export function externalIdFor(w: TpWorkout, occurrence: number): string {
  const identity = [w.day, w.type ?? "", w.title ?? "", w.hours ?? "", occurrence].join("|");
  return `trainingpeaks:${w.day}:${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export function activitiesFromWorkouts(workouts: readonly TpWorkout[], timeZone: string) {
  const seen = new Map<string, number>();
  return workouts.filter(isCompleted).map((w): NewActivity => {
    const base = [w.day, w.type, w.title, w.hours].join("|");
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    const sport = sportFromTrainingPeaks(w.type, w.title);
    const durationSeconds = Math.round((w.hours ?? 0) * 3600);
    const distance = w.distanceMeters && w.distanceMeters > 0 ? w.distanceMeters : null;
    const notes = [w.athleteComments, w.coachComments && `Coach: ${w.coachComments}`]
      .filter(Boolean)
      .join("\n");
    return {
      externalId: externalIdFor(w, occurrence),
      source: "trainingpeaks_import",
      sport,
      name: w.title,
      // The export has only the day: noon local time keeps it on the right date.
      startedAt: new Date(localMidnight(w.day, timeZone).getTime() + 12 * 3600 * 1000),
      durationSeconds,
      elapsedSeconds: null,
      distanceMeters: distance,
      elevationGainMeters: w.elevationGainMeters,
      avgHr: w.avgHr === null ? null : Math.round(w.avgHr),
      maxHr: w.maxHr === null ? null : Math.round(w.maxHr),
      avgPacePerKm:
        PACE_SPORTS.has(sport) && distance
          ? Math.round((durationSeconds / (distance / 1000)) * 10) / 10
          : null,
      avgPower: w.avgPower,
      trainingLoad: w.tss,
      zoneDistribution: Object.keys(w.hrZoneMinutes).length > 0 ? w.hrZoneMinutes : null,
      laps: null,
      notes: notes || null,
      rawData: { trainingpeaks: w.raw },
    };
  });
}

// Strava syncs the same sessions (usually from the same watch), so a workout Strava already has
// would be counted twice in totals. Same local day, same sport and a duration within 20% is
// treated as the same session, and the Strava record (with laps and exact times) wins.
const DUPLICATE_DURATION_TOLERANCE = 0.2;

type Existing = Pick<ActivitySummary, "source" | "sport" | "startedAt" | "durationSeconds">;

// The Strava activity a TrainingPeaks row duplicates, if any.
export function stravaTwin<T extends Existing>(
  row: Pick<NewActivity, "sport" | "startedAt" | "durationSeconds">,
  existing: readonly T[],
  timeZone: string,
): T | undefined {
  const day = localDate(row.startedAt, timeZone);
  return existing.find(
    (a) =>
      a.source === "strava" &&
      a.sport === row.sport &&
      localDate(a.startedAt, timeZone) === day &&
      Math.abs(a.durationSeconds - row.durationSeconds) <=
        DUPLICATE_DURATION_TOLERANCE * Math.max(a.durationSeconds, row.durationSeconds),
  );
}

export function withoutStravaDuplicates(
  rows: readonly NewActivity[],
  existing: readonly Existing[],
  timeZone: string,
): { kept: NewActivity[]; skipped: NewActivity[] } {
  const kept: NewActivity[] = [];
  const skipped: NewActivity[] = [];
  for (const row of rows) (stravaTwin(row, existing, timeZone) ? skipped : kept).push(row);
  return { kept, skipped };
}

// ADR-021 backfill: every TrainingPeaks workout with a planned duration becomes a planned
// session. A completed one carries the external id its activity was imported under, so it can
// be linked. The session type is a fallback until `npm run workouts:classify` sets it.
export type TpPlannedSession = {
  key: string;
  workout: Workout;
  activityExternalId: string | null;
};

const SESSION_SPORTS: ReadonlySet<string> = new Set(STORED_SPORTS);

export function plannedSessionsFromWorkouts(workouts: readonly TpWorkout[]): TpPlannedSession[] {
  const completedSeen = new Map<string, number>();
  const plannedSeen = new Map<string, number>();
  const sessions: TpPlannedSession[] = [];
  for (const w of workouts) {
    const base = [w.day, w.type, w.title, w.hours].join("|");
    const seen = isCompleted(w) ? completedSeen : plannedSeen;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    if (isDayOff(w) || !w.plannedHours || w.plannedHours <= 0) continue;
    const externalId = externalIdFor(w, occurrence);
    const mapped = sportFromTrainingPeaks(w.type, w.title);
    const sport = (SESSION_SPORTS.has(mapped) ? mapped : "other") as StoredSport;
    const minutes = Math.max(1, Math.round(w.plannedHours * 60));
    const description = (w.description ?? w.title ?? "Planned session").replace(/\s+/g, " ");
    sessions.push({
      key: `tp:${externalId}`,
      activityExternalId: isCompleted(w) ? externalId : null,
      workout: {
        date: w.day,
        start_time: "12:00",
        sport,
        session_type: fallbackSessionType(sport),
        title: w.title ?? w.type ?? "Workout",
        // Whether TrainingPeaks' planned duration includes rest is unknown: both are the same.
        duration_minutes: minutes,
        active_minutes: minutes,
        brick_with_previous: false,
        intensity: "easy",
        structure: [{ segment: "main", description }],
        steps: null,
        targets: null,
        field_test: null,
        notes: w.coachComments,
      },
    });
  }
  return sessions;
}

const clock = (hours: number) => {
  const minutes = Math.round(hours * 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The plan as weekly notes: what was planned (with the coach's session descriptions) and what
// was done. Ingested with `--type notes`, it lets the coach look up past sessions and blocks.
export function planMarkdown(workouts: readonly TpWorkout[], title: string): string {
  const byWeek = new Map<string, TpWorkout[]>();
  for (const w of [...workouts].sort((a, b) => a.day.localeCompare(b.day))) {
    if (isDayOff(w)) continue;
    const week = weekStart(w.day);
    byWeek.set(week, [...(byWeek.get(week) ?? []), w]);
  }
  const lines = [`# ${title}`, ""];
  for (const [week, items] of byWeek) {
    const done = items.filter(isCompleted);
    const hours = done.reduce((sum, w) => sum + (w.hours ?? 0), 0);
    const tss = done.reduce((sum, w) => sum + (w.tss ?? 0), 0);
    lines.push(`## Week of ${week} to ${addDays(week, 6)}`, "");
    lines.push(
      `Completed ${done.length} of ${items.length} sessions, ${clock(hours)} h${tss > 0 ? `, TSS ${Math.round(tss)}` : ""}.`,
      "",
    );
    for (const w of items) {
      const weekday = WEEKDAYS[new Date(`${w.day}T00:00:00Z`).getUTCDay()];
      const planned = w.plannedHours ? `planned ${clock(w.plannedHours)}` : null;
      const actual = isCompleted(w)
        ? `done ${clock(w.hours ?? 0)}${w.distanceMeters ? ` / ${(w.distanceMeters / 1000).toFixed(1)} km` : ""}${w.avgHr ? `, avg HR ${Math.round(w.avgHr)}` : ""}${w.tss ? `, TSS ${Math.round(w.tss)}` : ""}`
        : "not done";
      const detail = [planned, actual].filter(Boolean).join(", ");
      lines.push(
        `- ${weekday} ${w.day} ${w.type ?? "Workout"}: ${w.title ?? "(untitled)"} (${detail})`,
      );
      if (w.description) lines.push(`  Plan: ${w.description.replace(/\s+/g, " ")}`);
      if (w.athleteComments) lines.push(`  Athlete: ${w.athleteComments.replace(/\s+/g, " ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

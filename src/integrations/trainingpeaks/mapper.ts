import { createHash } from "node:crypto";
import type { ActivitySummary, NewActivity } from "../../db/activities.js";
import { addDays, localDate, localMidnight, weekStart } from "../../utils/dates.js";
import type { TpWorkout } from "./workouts.js";

// TrainingPeaks workouts → `activities` rows (source 'trainingpeaks_import') and a Markdown
// digest of the plan for the literature corpus (spec.md §7.4).

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

export function withoutStravaDuplicates(
  rows: readonly NewActivity[],
  existing: readonly Pick<ActivitySummary, "source" | "sport" | "startedAt" | "durationSeconds">[],
  timeZone: string,
): { kept: NewActivity[]; skipped: NewActivity[] } {
  const strava = existing.filter((a) => a.source === "strava");
  const kept: NewActivity[] = [];
  const skipped: NewActivity[] = [];
  for (const row of rows) {
    const day = localDate(row.startedAt, timeZone);
    const duplicate = strava.some(
      (a) =>
        a.sport === row.sport &&
        localDate(a.startedAt, timeZone) === day &&
        Math.abs(a.durationSeconds - row.durationSeconds) <=
          DUPLICATE_DURATION_TOLERANCE * Math.max(a.durationSeconds, row.durationSeconds),
    );
    (duplicate ? skipped : kept).push(row);
  }
  return { kept, skipped };
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

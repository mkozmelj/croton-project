import type { ActivitySummary } from "../db/activities.js";
import type { HealthMetrics } from "../db/health-metrics.js";

// Plain-text renderings of stored data, shared by the prompt context, the activity
// summary fallback and /status. Metric units and 24-hour times (system prompt rules).

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

export function formatPace(secondsPerKm: number): string {
  const seconds = Math.round(secondsPerKm);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} /km`;
}

export function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(meters < 10_000 ? 2 : 1)} km`;
}

export function formatDayTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

// One line per activity, e.g. `run "Tempo" 8.10 km in 42:36, 5:15 /km, HR 158 avg / 171 max`.
// The name is athlete-entered text: it is quoted and treated as data (system prompt rule).
export function describeActivity(activity: ActivitySummary): string {
  const parts = [activity.sport];
  if (activity.name) parts.push(JSON.stringify(activity.name));
  const main = activity.distanceMeters
    ? `${formatKm(activity.distanceMeters)} in ${formatDuration(activity.durationSeconds)}`
    : formatDuration(activity.durationSeconds);
  const details = [main];
  if (activity.avgPacePerKm) details.push(formatPace(activity.avgPacePerKm));
  if (activity.avgHr) {
    details.push(`HR ${activity.avgHr} avg${activity.maxHr ? ` / ${activity.maxHr} max` : ""}`);
  }
  if (activity.elevationGainMeters && activity.elevationGainMeters >= 20) {
    details.push(`${Math.round(activity.elevationGainMeters)} m D+`);
  }
  if (activity.avgPower) details.push(`${Math.round(activity.avgPower)} W`);
  if (activity.trainingLoad) details.push(`relative effort ${Math.round(activity.trainingLoad)}`);
  return `${parts.join(" ")}: ${details.join(", ")}`;
}

export type SportTotals = {
  sport: string;
  sessions: number;
  durationSeconds: number;
  distanceMeters: number;
  elevationGainMeters: number;
};

// Per-sport totals, biggest time first.
export function totalsBySport(activities: readonly ActivitySummary[]): SportTotals[] {
  const totals = new Map<string, SportTotals>();
  for (const activity of activities) {
    const entry = totals.get(activity.sport) ?? {
      sport: activity.sport,
      sessions: 0,
      durationSeconds: 0,
      distanceMeters: 0,
      elevationGainMeters: 0,
    };
    entry.sessions += 1;
    entry.durationSeconds += activity.durationSeconds;
    entry.distanceMeters += activity.distanceMeters ?? 0;
    entry.elevationGainMeters += activity.elevationGainMeters ?? 0;
    totals.set(activity.sport, entry);
  }
  return [...totals.values()].sort((a, b) => b.durationSeconds - a.durationSeconds);
}

export function describeTotals(totals: SportTotals): string {
  const parts = [`${totals.sessions}x`, formatDuration(totals.durationSeconds)];
  if (totals.distanceMeters > 0) parts.push(formatKm(totals.distanceMeters));
  if (totals.elevationGainMeters >= 50)
    parts.push(`${Math.round(totals.elevationGainMeters)} m D+`);
  return `${totals.sport}: ${parts.join(", ")}`;
}

const hoursMinutes = (minutes: number) =>
  `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;

// e.g. `sleep 7h12 (deep 1h20, REM 1h35, score 82), HRV 62 ms, resting HR 48, ...`.
export function describeHealth(row: HealthMetrics): string {
  const parts: string[] = [];
  if (row.sleepDurationMinutes != null) {
    const stages = [
      row.deepSleepMinutes != null ? `deep ${hoursMinutes(row.deepSleepMinutes)}` : null,
      row.remSleepMinutes != null ? `REM ${hoursMinutes(row.remSleepMinutes)}` : null,
      row.sleepQualityScore != null ? `score ${Math.round(row.sleepQualityScore)}` : null,
    ].filter((part) => part !== null);
    const detail = stages.length > 0 ? ` (${stages.join(", ")})` : "";
    parts.push(`sleep ${hoursMinutes(row.sleepDurationMinutes)}${detail}`);
  }
  if (row.hrvMs != null) parts.push(`HRV ${Math.round(row.hrvMs)} ms`);
  if (row.restingHr != null) parts.push(`resting HR ${row.restingHr}`);
  if (row.bodyBattery != null) parts.push(`Body Battery ${row.bodyBattery}`);
  if (row.stressAvg != null) parts.push(`stress ${row.stressAvg}`);
  if (row.weightKg != null) parts.push(`weight ${row.weightKg.toFixed(1)} kg`);
  if (row.bodyFatPct != null) parts.push(`body fat ${row.bodyFatPct.toFixed(1)}%`);
  return parts.length > 0 ? parts.join(", ") : "no values";
}

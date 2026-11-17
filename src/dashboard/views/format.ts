import { formatKm, formatPace } from "../../agent/activity-format.js";
import type { ActivitySummary } from "../../db/activities.js";
import type { WorkoutStatus } from "../../training/plan.js";
import type { ProgressMetric } from "../../training/progress.js";

// Plain-text renderings for the dashboard pages. The views escape what these return.

export const DASHBOARD_PATH = "/dashboard";

export function minutes(total: number): string {
  const rounded = Math.round(total);
  if (rounded < 60) return `${rounded} min`;
  return `${Math.floor(rounded / 60)} h ${String(rounded % 60).padStart(2, "0")}`;
}

export const hours = (totalMinutes: number) => `${(totalMinutes / 60).toFixed(1)} h`;

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const shortFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const longFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const utc = (date: string) => new Date(`${date}T00:00:00Z`);

// "Mon 16 Nov", "16 Nov", "16 Nov 2026" for a local date.
export const dayLabel = (date: string) => dayFormat.format(utc(date));
export const shortDate = (date: string) => shortFormat.format(utc(date));
export const longDate = (date: string) => longFormat.format(utc(date));

const STATUS_LABEL: Record<WorkoutStatus, string> = {
  upcoming: "Upcoming",
  done: "Done",
  partial: "Partial",
  unconfirmed: "Unconfirmed",
  skipped: "Skipped",
  replaced: "Replaced",
};

export const statusLabel = (status: WorkoutStatus) => STATUS_LABEL[status];

// "run_vo2" → "Run VO2", "swim_css" → "Swim CSS".
export function typeLabel(type: string): string {
  const words = type
    .split("_")
    .map((word) => (["vo2", "css"].includes(word) ? word.toUpperCase() : word));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function swimPace(secondsPer100m: number): string {
  const seconds = Math.round(secondsPer100m);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} /100 m`;
}

const METRIC_LABEL: Record<ProgressMetric, string> = {
  pace: "Pace",
  swim_pace: "Pace /100 m",
  power: "Power",
  duration: "Duration",
  rpe: "RPE",
};

export const metricLabel = (metric: ProgressMetric) => METRIC_LABEL[metric];

export function metricValue(metric: ProgressMetric, value: number): string {
  switch (metric) {
    case "pace":
      return formatPace(value);
    case "swim_pace":
      return swimPace(value);
    case "power":
      return `${Math.round(value)} W`;
    case "duration":
      return minutes(value);
    case "rpe":
      return `RPE ${Math.round(value * 10) / 10}`;
  }
}

// "48 min · 9.20 km", the short form of what was done.
export function activityShort(activity: ActivitySummary): string {
  const parts = [minutes(activity.durationSeconds / 60)];
  if (activity.distanceMeters) parts.push(formatKm(activity.distanceMeters));
  return parts.join(" · ");
}

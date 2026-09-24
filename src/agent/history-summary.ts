import type { ActivitySummary } from "../db/activities.js";
import { addDays, weekStart } from "../utils/dates.js";
import { describeTotals, formatDuration, formatKm, totalsBySport } from "./activity-format.js";

// The long view for plan generation: what volume the athlete has handled over the last
// year, to set a starting point and judge the distance to their best shape.

type DayOf = (activity: ActivitySummary) => string;

// One line per calendar month with activity, oldest first.
export function monthlyLines(activities: readonly ActivitySummary[], dayOf: DayOf): string[] {
  const byMonth = new Map<string, ActivitySummary[]>();
  for (const activity of activities) {
    const month = dayOf(activity).slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), activity]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, list]) => `- ${month}: ${totalsBySport(list).map(describeTotals).join("; ")}`);
}

// Per sport: the biggest training week (by time) and the longest single session.
export function peakLines(activities: readonly ActivitySummary[], dayOf: DayOf): string[] {
  const bySport = new Map<string, ActivitySummary[]>();
  for (const activity of activities) {
    bySport.set(activity.sport, [...(bySport.get(activity.sport) ?? []), activity]);
  }
  const lines: string[] = [];
  for (const [sport, list] of [...bySport.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const weeks = new Map<string, ActivitySummary[]>();
    for (const activity of list) {
      const start = weekStart(dayOf(activity));
      weeks.set(start, [...(weeks.get(start) ?? []), activity]);
    }
    const [bestWeek, bestList] = [...weeks.entries()]
      .map(([start, items]) => [start, items, total(items)] as const)
      .sort((a, b) => b[2] - a[2])[0] ?? [null, [], 0];
    const longest = [...list].sort((a, b) => b.durationSeconds - a.durationSeconds)[0];
    const parts: string[] = [];
    if (bestWeek) {
      const [totals] = totalsBySport(bestList);
      if (totals)
        parts.push(
          `biggest week Mon ${bestWeek}: ${describeTotals(totals).replace(`${sport}: `, "")}`,
        );
    }
    if (longest) {
      const distance = longest.distanceMeters ? `, ${formatKm(longest.distanceMeters)}` : "";
      parts.push(
        `longest session ${dayOf(longest)}: ${formatDuration(longest.durationSeconds)}${distance}`,
      );
    }
    if (parts.length > 0) lines.push(`- ${sport}: ${parts.join("; ")}`);
  }
  return lines;
}

const total = (items: readonly ActivitySummary[]) =>
  items.reduce((sum, a) => sum + a.durationSeconds, 0);

// The Monday a year of history starts on, for fetching.
export const historyStart = (thisWeek: string) => addDays(thisWeek, -7 * 52);

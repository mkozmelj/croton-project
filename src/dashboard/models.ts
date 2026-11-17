import type { ActivitySummary } from "../db/activities.js";
import type { SessionRecord } from "../db/planned-workouts.js";
import { type Completion, completion } from "../training/completion.js";
import { type ProgressSpec, progressSpec, progressValue } from "../training/progress.js";
import { SESSION_TYPES, type SessionType } from "../training/session-types.js";
import { addDays } from "../utils/dates.js";

// ADR-022: what each dashboard page shows, shaped from the stores' rows. Pure, so the views
// stay HTML only and the numbers are testable without a database.

const isLive = (record: SessionRecord) => record.session.status !== "replaced";
const countable = (records: readonly SessionRecord[]) =>
  records.map(({ session }) => ({ status: session.status, activeMinutes: session.activeMinutes }));

export type DayModel = {
  date: string;
  sessions: SessionRecord[];
  // Activities that fulfilled no session: greyed, counted in the week's hours only.
  unplanned: ActivitySummary[];
};

export type WeekModel = {
  weekStart: string;
  days: DayModel[];
  completion: Completion;
  // Active minutes of the week's sessions, and the moving time of every activity in it.
  plannedMinutes: number;
  actualSeconds: number;
};

export function weekModel(
  weekStart: string,
  records: readonly SessionRecord[],
  activities: readonly ActivitySummary[],
  localDateOf: (instant: Date) => string,
): WeekModel {
  const live = records.filter(isLive);
  const linked = new Set(records.flatMap(({ session }) => session.activityId ?? []));
  const unplanned = activities.filter((activity) => !linked.has(activity.id));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    return {
      date,
      sessions: live.filter(({ session }) => session.date === date),
      unplanned: unplanned.filter((activity) => localDateOf(activity.startedAt) === date),
    };
  });
  return {
    weekStart,
    days,
    completion: completion(countable(live)),
    plannedMinutes: live.reduce((sum, { session }) => sum + session.activeMinutes, 0),
    actualSeconds: activities.reduce((sum, activity) => sum + activity.durationSeconds, 0),
  };
}

export type CompletionWeek = { weekStart: string; completion: Completion };

export type CompletionModel = {
  weeks: CompletionWeek[];
  overall: Completion;
  lastFourWeeks: Completion;
  // Newest first.
  skipped: SessionRecord[];
  partial: SessionRecord[];
};

// `records` covers the `weekCount` weeks ending with the week starting `lastWeekStart`.
export function completionModel(
  lastWeekStart: string,
  weekCount: number,
  records: readonly SessionRecord[],
): CompletionModel {
  const live = records.filter(isLive);
  const weekStarts = Array.from({ length: weekCount }, (_, i) =>
    addDays(lastWeekStart, -7 * (weekCount - 1 - i)),
  );
  const inWeeks = (from: string) => live.filter(({ session }) => session.weekStart >= from);
  const newestFirst = (status: string) =>
    live.filter(({ session }) => session.status === status).reverse();
  return {
    weeks: weekStarts.map((weekStart) => ({
      weekStart,
      completion: completion(
        countable(live.filter(({ session }) => session.weekStart === weekStart)),
      ),
    })),
    overall: completion(countable(live)),
    lastFourWeeks: completion(countable(inWeeks(addDays(lastWeekStart, -21)))),
    skipped: newestFirst("skipped"),
    partial: newestFirst("partial"),
  };
}

export type ProgressPoint = {
  record: SessionRecord;
  activity: ActivitySummary;
  spec: ProgressSpec;
  value: number | null;
};

export type TypeModel = {
  type: SessionType;
  // The spec of the sport most of its sessions are (a brick's legs differ).
  spec: ProgressSpec;
  sessions: SessionRecord[];
  // Done and partial sessions with their activity, oldest first.
  points: ProgressPoint[];
};

export function typeModel(type: SessionType, records: readonly SessionRecord[]): TypeModel {
  const sessions = records.filter(isLive);
  const points = sessions.flatMap((record): ProgressPoint[] => {
    const { session, activity, feedback } = record;
    if (!activity || (session.status !== "done" && session.status !== "partial")) return [];
    const spec = progressSpec(type, session.sport);
    const value = progressValue(spec.metric, { ...activity, rpe: feedback?.rpe ?? null });
    return [{ record, activity, spec, value }];
  });
  return { type, spec: progressSpec(type, mainSport(sessions)), sessions, points };
}

function mainSport(sessions: readonly SessionRecord[]): string {
  const counts = new Map<string, number>();
  for (const { session } of sessions) {
    counts.set(session.sport, (counts.get(session.sport) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}

export type TypeSummary = {
  type: SessionType;
  sessions: number;
  // Done or partial, with an activity.
  completed: number;
  // The most recent progress point with a value, if any.
  latest: ProgressPoint | null;
};

// One line per session type that has sessions, in SESSION_TYPES order (families together).
export function typeSummaries(records: readonly SessionRecord[]): TypeSummary[] {
  return SESSION_TYPES.flatMap((type): TypeSummary[] => {
    const model = typeModel(
      type,
      records.filter(({ session }) => session.sessionType === type),
    );
    if (model.sessions.length === 0) return [];
    return [
      {
        type,
        sessions: model.sessions.length,
        completed: model.points.length,
        latest: model.points.findLast((point) => point.value !== null) ?? null,
      },
    ];
  });
}

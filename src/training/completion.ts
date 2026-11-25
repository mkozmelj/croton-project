import { addDays, weekStart } from "../utils/dates.js";
import type { WorkoutStatus } from "./plan.js";

// ADR-021 completion rate. Counted over done, partial and skipped sessions; upcoming,
// unconfirmed and replaced sessions don't count yet (or ever). A partial session counts half,
// in sessions and in hours. Shared by the dashboard, the Sunday recap and /status, so they
// never disagree.

// The recent window of the recap, /status, chat and plan generation.
export const COMPLETION_WEEKS = 4;

export const COUNTED_STATUSES: readonly WorkoutStatus[] = ["done", "partial", "skipped"];

// Over this share of the active minutes a done session is marked "longer than planned".
export const LONGER_THAN_PLANNED_SHARE = 1.2;

export type CountableSession = { status: WorkoutStatus; activeMinutes: number };

export type Completion = {
  counted: number;
  done: number;
  partial: number;
  skipped: number;
  // Active minutes of the counted sessions, and the share of them completed (partial = ½).
  plannedMinutes: number;
  completedMinutes: number;
  // 0-1, null when nothing counts yet.
  sessionsRate: number | null;
  hoursRate: number | null;
};

export function completion(sessions: readonly CountableSession[]): Completion {
  let done = 0;
  let partial = 0;
  let skipped = 0;
  let plannedMinutes = 0;
  let completedMinutes = 0;
  for (const session of sessions) {
    if (!COUNTED_STATUSES.includes(session.status)) continue;
    plannedMinutes += session.activeMinutes;
    if (session.status === "done") {
      done += 1;
      completedMinutes += session.activeMinutes;
    } else if (session.status === "partial") {
      partial += 1;
      completedMinutes += session.activeMinutes / 2;
    } else {
      skipped += 1;
    }
  }
  const counted = done + partial + skipped;
  return {
    counted,
    done,
    partial,
    skipped,
    plannedMinutes,
    completedMinutes,
    sessionsRate: counted === 0 ? null : (done + partial / 2) / counted,
    hoursRate: plannedMinutes === 0 ? null : completedMinutes / plannedMinutes,
  };
}

export type DatedSession = CountableSession & { date: string };

// A window's rate, plus its past sessions still waiting for a match or an answer.
export type CompletionWindow = Completion & { open: number };

// For the Sunday recap and /status: this week (Monday to today) and the last
// COMPLETION_WEEKS weeks. Today's sessions count once they're done; an unanswered one only
// counts as open from the next day.
export type CompletionSummary = { week: CompletionWindow; recent: CompletionWindow };

export function completionSummary(
  sessions: readonly DatedSession[],
  today: string,
): CompletionSummary {
  return {
    week: completionWindow(sessions, weekStart(today), today),
    recent: completionWindow(sessions, addDays(today, -7 * COMPLETION_WEEKS), today),
  };
}

function completionWindow(
  sessions: readonly DatedSession[],
  from: string,
  today: string,
): CompletionWindow {
  const inWindow = sessions.filter((session) => session.date >= from && session.date <= today);
  const open = inWindow.filter(
    (session) =>
      session.date < today && (session.status === "upcoming" || session.status === "unconfirmed"),
  ).length;
  return { ...completion(inWindow), open };
}

// A done session whose activity ran well past the plan.
export function longerThanPlanned(activeMinutes: number, activitySeconds: number): boolean {
  return activeMinutes > 0 && activitySeconds / 60 > LONGER_THAN_PLANNED_SHARE * activeMinutes;
}

// "83%", or "–" when nothing counts.
export function formatRate(rate: number | null): string {
  return rate === null ? "–" : `${Math.round(rate * 100)}%`;
}

import { z } from "zod";
import type { PlannedWorkoutStore, SessionRecord } from "../db/planned-workouts.js";
import {
  COMPLETION_WEEKS,
  type CompletionSummary,
  completion,
  completionSummary,
  formatRate,
} from "../training/completion.js";
import { addDays } from "../utils/dates.js";

// ADR-021 "The planner sees history": what plan generation gets of past sessions, so it can
// progress a session type from its last occurrence instead of handing out the same session
// again. Plain text for the prompt (after the cache breakpoint, ADR-004).

// The window and the per-type cap keep this at about 1-2k tokens.
export const PLANNER_HISTORY_WEEKS = 12;
export const PLANNER_HISTORY_PER_TYPE = 3;
// A long main-set description is cut here.
const MAIN_SET_CHARS = 140;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// Stored structure is jsonb; anything that doesn't parse just has no main set.
const structureSchema = z.array(z.object({ segment: z.string(), description: z.string() }));

// The Sunday recap's and /status's figures: this week and the last COMPLETION_WEEKS weeks.
export async function loadCompletion(
  sessions: Pick<PlannedWorkoutStore, "between">,
  today: string,
): Promise<CompletionSummary> {
  const records = await sessions.between(addDays(today, -7 * COMPLETION_WEEKS), addDays(today, 1));
  return completionSummary(
    records.map(({ session }) => ({
      date: session.date,
      status: session.status,
      activeMinutes: session.activeMinutes,
    })),
    today,
  );
}

// The first day of the history window, for the store query.
export function historyFrom(today: string): string {
  return addDays(today, -7 * PLANNER_HISTORY_WEEKS);
}

// Sessions before `today` only: today's and later sessions are the plan being written.
export function sessionHistoryLines(records: readonly SessionRecord[], today: string): string[] {
  const from = historyFrom(today);
  const past = records
    .filter(({ session }) => session.date >= from && session.date < today)
    .sort((a, b) => order(a).localeCompare(order(b)));
  const live = past.filter(({ session }) => session.status !== "replaced");

  const byType = new Map<string, SessionRecord[]>();
  for (const record of live) {
    const list = byType.get(record.session.sessionType) ?? [];
    list.push(record);
    byType.set(record.session.sessionType, list);
  }
  // Most recently trained types first.
  const types = [...byType].sort(([, a], [, b]) => lastDate(b).localeCompare(lastDate(a)));
  const typeLines = types.flatMap(([type, list]) =>
    list.slice(-PLANNER_HISTORY_PER_TYPE).map((record) => `- ${type} ${sessionLine(record)}`),
  );

  return [
    `SESSION HISTORY BY TYPE (last ${PLANNER_HISTORY_PER_TYPE} of each type over ${PLANNER_HISTORY_WEEKS} weeks, oldest first; planned/done active minutes)`,
    ...(typeLines.length > 0 ? typeLines : ["- no past sessions yet"]),
    "",
    "PLAN ADHERENCE",
    completionLine(records, today),
    weekdayLine(past),
  ];
}

function order({ session }: SessionRecord): string {
  return `${session.date} ${session.startTime} ${String(session.id).padStart(10, "0")}`;
}

function lastDate(list: readonly SessionRecord[]): string {
  return list.at(-1)?.session.date ?? "";
}

// e.g. `11-04 "Threshold intervals" main: 4x8 min Z4; 50/48 min, done, RPE 7, felt good`.
export function sessionLine({ session, activity, feedback }: SessionRecord): string {
  const head = `${session.date.slice(5)} ${JSON.stringify(session.title)}`;
  const main = mainSet(session.structure);
  const minutes = activity
    ? `${session.activeMinutes}/${Math.round(activity.durationSeconds / 60)} min`
    : `${session.activeMinutes} min planned`;
  const outcome = [minutes, statusLabel(session.status)];
  if (feedback?.rpe != null) outcome.push(`RPE ${feedback.rpe}`);
  if (feedback?.feel) outcome.push(`felt ${feedback.feel}`);
  if (feedback?.pain === true) outcome.push("pain reported");
  return `${main ? `${head} main: ${main}` : head}; ${outcome.join(", ")}`;
}

function mainSet(structure: unknown): string | null {
  const parsed = structureSchema.safeParse(structure);
  if (!parsed.success) return null;
  const text = parsed.data
    .filter((segment) => segment.segment === "main")
    .map((segment) => segment.description.trim())
    .filter((description) => description.length > 0)
    .join("; ");
  if (text.length === 0) return null;
  return text.length > MAIN_SET_CHARS ? `${text.slice(0, MAIN_SET_CHARS - 1)}…` : text;
}

// A past session still `upcoming` or `unconfirmed` has no answer yet (no match, no button).
function statusLabel(status: SessionRecord["session"]["status"]): string {
  return status === "upcoming" || status === "unconfirmed" ? "not confirmed" : status;
}

// The 4-week rate, one line: plan generation's PLAN ADHERENCE, and chat context.
export function completionLine(records: readonly SessionRecord[], today: string): string {
  const from = addDays(today, -7 * COMPLETION_WEEKS);
  const recent = records.filter(
    ({ session }) => session.status !== "replaced" && session.date >= from && session.date < today,
  );
  const rate = completion(
    recent.map(({ session }) => ({ status: session.status, activeMinutes: session.activeMinutes })),
  );
  const open = recent.length - rate.counted;
  const unanswered = open > 0 ? `; ${open} not confirmed` : "";
  if (rate.counted === 0) {
    return `- Last ${COMPLETION_WEEKS} weeks: nothing counted yet${unanswered}`;
  }
  return `- Last ${COMPLETION_WEEKS} weeks: sessions ${formatRate(rate.sessionsRate)}, hours ${formatRate(rate.hoursRate)} (${rate.done} done, ${rate.partial} partial, ${rate.skipped} skipped${unanswered})`;
}

// Moved = replaced by a plan change; skipped = planned and not done.
function weekdayLine(past: readonly SessionRecord[]): string {
  const counts = new Map<number, { moved: number; skipped: number }>();
  for (const { session } of past) {
    const moved = session.status === "replaced" && session.statusSource === "plan_change";
    const skipped = session.status === "skipped";
    if (!moved && !skipped) continue;
    const day = new Date(`${session.date}T00:00:00Z`).getUTCDay();
    const entry = counts.get(day) ?? { moved: 0, skipped: 0 };
    if (moved) entry.moved += 1;
    else entry.skipped += 1;
    counts.set(day, entry);
  }
  // Monday first.
  const days = [1, 2, 3, 4, 5, 6, 0].flatMap((day) => {
    const entry = counts.get(day);
    if (!entry) return [];
    const parts = [
      ...(entry.skipped > 0 ? [`${entry.skipped} skipped`] : []),
      ...(entry.moved > 0 ? [`${entry.moved} moved`] : []),
    ];
    return [`${WEEKDAYS[day]} ${parts.join(", ")}`];
  });
  return `- Moved or skipped by weekday, ${PLANNER_HISTORY_WEEKS} weeks: ${days.length > 0 ? days.join("; ") : "none"}`;
}

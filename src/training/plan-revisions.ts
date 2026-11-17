import type { Workout } from "./plan.js";

// ADR-021: what a confirmed plan change does to the week's sessions it supersedes. The old
// rows stay, as 'replaced', pointing to the session that took their place, so the planner can
// see which sessions keep moving. A session dropped on its own day without a successor counts
// as skipped: changing the plan on the day doesn't hide a missed session.

export type Replacement = {
  id: number;
  status: "replaced" | "skipped";
  successorKey: string | null;
};

type Incoming = { key: string; workout: Workout };

// `superseded`: the week's stored sessions from today on that aren't done or partial.
export function replacements(
  superseded: readonly Workout[],
  incoming: readonly Incoming[],
  today: string,
): Replacement[] {
  const free = [...incoming];
  const take = (found: Incoming | undefined) => {
    if (found) free.splice(free.indexOf(found), 1);
    return found ?? null;
  };
  const byDistance = (date: string) => (a: Incoming, b: Incoming) =>
    dayDistance(a.workout.date, date) - dayDistance(b.workout.date, date);

  return superseded.flatMap((old) => {
    if (old.id === undefined) return [];
    // The same session type, nearest day first (a moved session); else the same day and sport
    // (a swapped one).
    const successor =
      take(
        free
          .filter((n) => n.workout.session_type === old.session_type)
          .sort(byDistance(old.date))[0],
      ) ?? take(free.find((n) => n.workout.date === old.date && n.workout.sport === old.sport));
    const status = old.date <= today && successor === null ? "skipped" : "replaced";
    return [{ id: old.id, status, successorKey: successor?.key ?? null }];
  });
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

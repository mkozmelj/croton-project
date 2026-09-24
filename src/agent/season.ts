import type { GoalStore, GoalWithEvent } from "../db/goals.js";
import { derivePhase, type Phase } from "../training/phase.js";
import { addDays } from "../utils/dates.js";

// ADR-010: B/C events in this window go into the context.
export const MINOR_EVENT_WINDOW_DAYS = 84;
// An A event this recent still drives the phase (transition).
const RECENT_A_DAYS = 28;

export type SeasonView = {
  aGoal: GoalWithEvent | null;
  phase: Phase | null;
  // Active B/C goals with events from `onDate` to 12 weeks after, soonest first.
  minor: GoalWithEvent[];
  // Every active goal from `onDate` on, soonest first (for /goals).
  upcoming: GoalWithEvent[];
};

// The A goal that anchors the plan: the next A event, or one that just happened.
export function seasonView(goals: readonly GoalWithEvent[], onDate: string): SeasonView {
  const recentFrom = addDays(onDate, -RECENT_A_DAYS);
  const aGoal =
    goals
      .filter((g) => g.priority === "A" && g.event.date >= recentFrom)
      .sort((a, b) => a.event.date.localeCompare(b.event.date))
      .find((g) => g.event.date >= onDate) ??
    goals.find((g) => g.priority === "A" && g.event.date >= recentFrom && g.event.date < onDate) ??
    null;
  const windowEnd = addDays(onDate, MINOR_EVENT_WINDOW_DAYS);
  const upcoming = goals
    .filter((g) => g.event.date >= onDate)
    .sort((a, b) => a.event.date.localeCompare(b.event.date));
  return {
    aGoal,
    phase: aGoal ? derivePhase(aGoal.event.date, onDate) : null,
    minor: upcoming.filter((g) => g.priority !== "A" && g.event.date <= windowEnd),
    upcoming,
  };
}

// Goals relevant around `onDate`: last season's (a recent A event) through next season's.
export async function loadSeason(
  goals: Pick<GoalStore, "activeInSeasons">,
  onDate: string,
): Promise<SeasonView> {
  const year = Number(onDate.slice(0, 4));
  return seasonView(await goals.activeInSeasons([year - 1, year, year + 1]), onDate);
}

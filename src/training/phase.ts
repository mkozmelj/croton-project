import { ageInDays } from "./markers.js";

// ADR-010: the periodization phase is derived from the A event date, never stored.
export const PHASES = ["base", "build", "peak", "race", "transition"] as const;
export type Phase = (typeof PHASES)[number];

// Back-planned from the A event (static system prompt, Friel): race week, 2 weeks peak,
// 8 weeks build, base before that. Up to 4 weeks after the event: transition.
const PEAK_WEEKS = 2;
const BUILD_WEEKS = 8;
const TRANSITION_DAYS = 28;

// `onDate` is the day the phase is wanted for (today, or the Monday of a planned week).
export function derivePhase(aEventDate: string, onDate: string): Phase | null {
  const daysToEvent = -ageInDays(aEventDate, onDate);
  if (daysToEvent < 0) return -daysToEvent <= TRANSITION_DAYS ? "transition" : null;
  const weeks = Math.floor(daysToEvent / 7);
  if (weeks === 0) return "race";
  if (weeks <= PEAK_WEEKS) return "peak";
  if (weeks <= PEAK_WEEKS + BUILD_WEEKS) return "build";
  return "base";
}

export function weeksAndDaysUntil(
  eventDate: string,
  today: string,
): { weeks: number; days: number } {
  const days = Math.max(0, -ageInDays(eventDate, today));
  return { weeks: Math.floor(days / 7), days };
}

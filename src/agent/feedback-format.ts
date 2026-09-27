import type { ActivitySummary } from "../db/activities.js";
import type { ActivityFeedback } from "../db/activity-feedback.js";

// Plain-text renderings of the athlete's activity feedback (ADR-018), for the prompt.

// e.g. `RPE 7, felt meh, pain: "left calf tight", note: "legs heavy"`. Empty when unanswered.
export function describeFeedback(feedback: ActivityFeedback): string {
  const parts: string[] = [];
  if (feedback.rpe !== null) parts.push(`RPE ${feedback.rpe}`);
  if (feedback.feel) parts.push(`felt ${feedback.feel}`);
  if (feedback.pain === false) parts.push("no pain");
  if (feedback.pain === true) {
    parts.push(feedback.painNote ? `pain: ${JSON.stringify(feedback.painNote)}` : "pain reported");
  }
  if (feedback.note) parts.push(`note: ${JSON.stringify(feedback.note)}`);
  return parts.join(", ");
}

export type RpeLoad = {
  // Session RPE × moving minutes, summed over the rated activities.
  load: number;
  rated: number;
  total: number;
};

export function sessionRpeLoad(
  activities: readonly Pick<ActivitySummary, "id" | "durationSeconds">[],
  feedback: ReadonlyMap<number, ActivityFeedback>,
): RpeLoad {
  let load = 0;
  let rated = 0;
  for (const activity of activities) {
    const rpe = feedback.get(activity.id)?.rpe;
    if (rpe == null) continue;
    load += rpe * (activity.durationSeconds / 60);
    rated++;
  }
  return { load: Math.round(load), rated, total: activities.length };
}

// Null when no activity in the period was rated.
export function describeRpeLoad({ load, rated, total }: RpeLoad): string | null {
  if (rated === 0) return null;
  return `session RPE load ${load} (RPE × min, ${rated} of ${total} activities rated)`;
}

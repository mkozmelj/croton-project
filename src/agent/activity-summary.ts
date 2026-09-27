import type { ActivitySummary } from "../db/activities.js";
import { describeActivity, formatDayTime } from "./activity-format.js";
import { BudgetExceededError } from "./budget.js";
import type { Claude } from "./claude.js";
import type { ContextBuilder } from "./context.js";
import { replyText } from "./orchestrator.js";

type SummaryDeps = {
  claude: Pick<Claude, "call">;
  context: ContextBuilder;
  timeZone: string;
};

export type ActivitySummarizer = {
  // The coach's comment on a newly synced activity (the bot shows the numbers above it), or
  // null when the budget doesn't allow a model call.
  summarize(activity: ActivitySummary): Promise<string | null>;
};

// spec.md §6.5: Haiku, no thinking (ADR-005 `activity_summary`). The context block already
// holds this week's totals, so the model can put the session into the week.
export function createActivitySummarizer(deps: SummaryDeps): ActivitySummarizer {
  return {
    async summarize(activity) {
      const line = `${formatDayTime(activity.startedAt, deps.timeZone)}: ${describeActivity(activity)}`;
      try {
        const { message } = await deps.claude.call({
          callType: "activity_summary",
          dynamicContext: await deps.context.build(),
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "A new activity just synced from Strava:",
                    `<activity>${line}${lapLine(activity)}</activity>`,
                    "",
                    "Write the coach's comment for the Telegram notification: 2-4 short sentences.",
                    "The activity's numbers are already shown above your text, so don't list them;",
                    "mention only the ones that matter. Put the session in the context of this week's",
                    "training so far (and the confirmed plan, if there is one: was this the",
                    "planned session, how many of the week's sessions are done) and the",
                    "athlete's recent recovery data. Flag anything",
                    "worth watching (unusually high HR for the pace, very short sleep, a big",
                    "jump in load). No greeting, no questions unless something looks wrong.",
                  ].join("\n"),
                },
              ],
            },
          ],
        });
        return replyText(message);
      } catch (error) {
        // Over budget: the athlete still gets the numbers, without a comment.
        if (error instanceof BudgetExceededError) return null;
        throw error;
      }
    },
  };
}

function lapLine(activity: ActivitySummary): string {
  if (!activity.laps || activity.laps.length > 20) return "";
  const laps = activity.laps.map((lap) => {
    const pace =
      lap.distanceMeters > 0
        ? ` ${Math.round(lap.movingSeconds / (lap.distanceMeters / 1000))}s/km`
        : "";
    const hr = lap.avgHr ? ` HR${lap.avgHr}` : "";
    const watts = lap.avgWatts ? ` ${Math.round(lap.avgWatts)}W` : "";
    return `${Math.round(lap.distanceMeters)}m ${lap.movingSeconds}s${pace}${hr}${watts}`;
  });
  return `\nLaps: ${laps.join(" | ")}`;
}

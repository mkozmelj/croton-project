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
  // The Telegram text for a newly synced activity.
  summarize(activity: ActivitySummary): Promise<string>;
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
                    "Write the Telegram notification about it: 2-4 short sentences.",
                    "Start with the key numbers, then put it in the context of this week's",
                    "training so far and the athlete's recent recovery data. Flag anything",
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
        // Over budget: still tell the athlete the activity arrived, without the LLM.
        if (error instanceof BudgetExceededError) return `New activity synced: ${line}`;
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

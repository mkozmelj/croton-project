import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Logger } from "pino";
import { z } from "zod";
import type { ConversationStore } from "../db/conversations.js";
import type { PendingActionStore } from "../db/pending-actions.js";
import { planIssues, weekPlanSchema } from "../training/plan.js";
import { addDays, localDate, weekStart } from "../utils/dates.js";
import {
  type ApplyPlanPayload,
  CONFIRMATION_TTL_MS,
  RECAP_TTL_MS,
  recapPayload,
} from "./actions.js";
import type { CalendarContext } from "./calendar-context.js";
import type { Claude } from "./claude.js";
import type { ContextBuilder } from "./context.js";
import { textOf } from "./history.js";
import { replyText } from "./orchestrator.js";
import { planText } from "./plan-format.js";
import type { Reply } from "./reply.js";

// Structured output of plan generation (stack doc §6): the recap message and the plan.
export const recapOutputSchema = z.object({
  recap: z.string().describe("The Telegram recap message, plain text"),
  plan: weekPlanSchema,
});

type PlannerDeps = {
  claude: Pick<Claude, "call">;
  context: ContextBuilder;
  conversations: Pick<ConversationStore, "append">;
  pending: Pick<PendingActionStore, "create" | "clear">;
  calendar: CalendarContext;
  chatId: number;
  timeZone: string;
  logger: Logger;
  now?: () => Date;
};

export type Planner = {
  // Opens the recap: the next message from the athlete is the week's feedback. Returns the
  // question to send.
  startRecap(): Promise<string>;
  // Generates the recap and next plan (Sonnet, medium effort, ADR-005 `plan_generation`) and
  // leaves the plan as a proposal to confirm (ADR-007).
  generate(request: { feedback: string; weekStart?: string }): Promise<Reply>;
};

// Friday to Sunday plans next week; Monday to Thursday re-plans the rest of this week.
export function planTargetWeek(today: string): string {
  const monday = weekStart(today);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return weekday === 0 || weekday >= 5 ? addDays(monday, 7) : monday;
}

export function createPlanner(deps: PlannerDeps): Planner {
  const log = deps.logger.child({ module: "planner" });
  const now = deps.now ?? (() => new Date());
  const format = zodOutputFormat(recapOutputSchema);

  return {
    async startRecap() {
      const target = planTargetWeek(localDate(now(), deps.timeZone));
      await deps.pending.clear(deps.chatId, ["recap"]);
      await deps.pending.create({
        chatId: deps.chatId,
        actionType: "recap",
        payload: recapPayload.parse({ weekStart: target }),
        expiresAt: new Date(now().getTime() + RECAP_TTL_MS),
      });
      return [
        `Weekly recap time. How did the week go? Any niggles, fatigue, illness, or things I should know about the week of Mon ${target} (travel, busy days, a race)?`,
        "",
        "Your next message is the feedback I'll plan from.",
      ].join("\n");
    },

    async generate({ feedback, weekStart: requested }) {
      const instant = now();
      const today = localDate(instant, deps.timeZone);
      const target = requested ?? planTargetWeek(today);
      const end = addDays(target, 6);
      const [context, calendar] = await Promise.all([
        deps.context.build({ detail: "baseline", planWeek: target }),
        deps.calendar.weekLines(target),
      ]);

      const prompt = [
        "Weekly recap and plan.",
        `<athlete_feedback>${feedback}</athlete_feedback>`,
        calendar
          ? `<athlete_calendar week="${target}">\n${calendar.length > 0 ? calendar.join("\n") : "(no events)"}\n</athlete_calendar>`
          : "(Calendar not connected: no information on the athlete's other appointments.)",
        "",
        `Plan the week Mon ${target} to Sun ${end}.${target <= today ? ` Only plan days from ${today} on; the week has already started.` : ""}`,
        "recap: the Telegram message. Open with any missing or stale fitness markers and the field test you scheduled for each. Then review last week (planned vs actual per sport, key sessions, intensity distribution), recovery (HRV, sleep, resting HR, ACWR), and the plan's focus and reasoning (phase, load progression of at most 10%, whether a recovery week is due). Plain text, short paragraphs, no Markdown, no session list (the plan is shown below it). 120-300 words.",
        "plan: every session of the week with start times that fit the athlete's availability and calendar, targets from the athlete's own zones (RPE where a sport has no anchor), field_test set on test sessions, B/C races handled per their priority. Rest days have no sessions.",
      ].join("\n");

      await deps.conversations.append({
        role: "user",
        content: [
          { type: "text", text: `[Weekly recap for the week of Mon ${target}]\n${feedback}` },
        ],
      });
      const { message, model } = await deps.claude.call({
        callType: "plan_generation",
        dynamicContext: context,
        outputFormat: format,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });

      const parsed =
        message.stop_reason === "end_turn"
          ? recapOutputSchema.safeParse(safeJson(textOf(message.content)))
          : null;
      if (!parsed?.success) {
        log.warn({ stopReason: message.stop_reason }, "plan generation returned no usable plan");
        const text =
          message.stop_reason === "end_turn"
            ? "The plan came back malformed, so nothing was proposed. Try /recap again."
            : replyText(message);
        return { text, proposals: [] };
      }

      const { recap, plan: generated } = parsed.data;
      const plan = { ...generated, week_start: target };
      // Keep the usable sessions; tell the athlete about any that had to be dropped.
      const dropped: string[] = [];
      plan.workouts = plan.workouts.filter((w) => {
        const issues = planIssues({ ...plan, workouts: [w] });
        if (issues.length > 0) dropped.push(...issues);
        return issues.length === 0 && w.date >= today;
      });
      if (dropped.length > 0) log.warn({ dropped }, "dropped invalid planned sessions");

      await deps.conversations.append({
        role: "assistant",
        content: [{ type: "text", text: `${recap}\n\n${planText(plan)}` }],
        model,
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      });

      await deps.pending.clear(deps.chatId, ["apply_plan"]);
      const payload: ApplyPlanPayload = {
        plan,
        recapNotes: feedback,
        agentAnalysis: recap,
        reason: null,
      };
      const proposal = await deps.pending.create({
        chatId: deps.chatId,
        actionType: "apply_plan",
        payload,
        expiresAt: new Date(instant.getTime() + CONFIRMATION_TTL_MS),
      });
      const note =
        dropped.length > 0
          ? `\n\n(${dropped.length} session(s) had invalid dates or times and were left out.)`
          : "";
      return { text: `${recap}${note}`, proposals: [proposal] };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

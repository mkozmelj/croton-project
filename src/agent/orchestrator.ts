import type {
  ContentBlockParam,
  Message,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { Logger } from "pino";
import { MODELS } from "../config/env.js";
import type { ActivityFeedbackStore } from "../db/activity-feedback.js";
import type { ConversationStore, ConversationTurn } from "../db/conversations.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";
import { localDate } from "../utils/dates.js";
import { activityFeedbackPayload, ONBOARDING_TTL_MS, recapPayload } from "./actions.js";
import { type RoutedCallType, routeMessage } from "./classifier.js";
import { CALL_POLICIES, type Claude } from "./claude.js";
import type { ContextBuilder } from "./context.js";
import { HISTORY_LIMIT, textOf, toMessageParams } from "./history.js";
import type { Planner } from "./planner.js";
import type { Reply } from "./reply.js";
import { runToolCall, type ToolHandlers } from "./tool-handlers.js";
import { CHAT_TOOLS, TOOL_NAMES } from "./tools.js";

// Tool rounds per message before the model has to answer in text. Proposals are one call
// each, so a full onboarding (profile + a few markers) fits.
export const MAX_TOOL_ROUNDS = 4;

// A short message this soon after a Sonnet reply is treated as part of that conversation.
export const FOLLOW_UP_WINDOW_MS = 15 * 60 * 1000;

type OrchestratorDeps = {
  claude: Pick<Claude, "call">;
  conversations: ConversationStore;
  context: ContextBuilder;
  tools: ToolHandlers;
  pending: Pick<PendingActionStore, "live" | "consume" | "create" | "clear">;
  planner: Pick<Planner, "generate">;
  feedback: Pick<ActivityFeedbackStore, "set">;
  chatId: number;
  timeZone: string;
  logger?: Logger;
  now?: () => Date;
};

export type IncomingMessage = {
  text: string;
  telegramMessageId: number;
  // `/deep <message>`: force Sonnet at medium effort.
  deep?: boolean;
};

export type Orchestrator = {
  handleMessage(incoming: IncomingMessage): Promise<Reply>;
  // /onboard: the following chat messages collect the athlete's background (ADR-016).
  startOnboarding(): Promise<void>;
};

const isHaiku = (callType: RoutedCallType) => CALL_POLICIES[callType].model === MODELS.haiku;

// Every free-text message is routed (classifier.ts) to a Sonnet or Haiku call type. An open
// activity-feedback note stores the message instead (ADR-018), and an open recap turns it
// into plan generation.
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? (() => new Date());

  // The previous reply (before the message just stored) was Sonnet's, and recent.
  function followsSonnet(turns: readonly ConversationTurn[]): boolean {
    const previous = turns.slice(0, -1).findLast((turn) => turn.role === "assistant");
    return (
      previous?.model === MODELS.sonnet &&
      now().getTime() - previous.createdAt.getTime() < FOLLOW_UP_WINDOW_MS
    );
  }

  async function chat({ text, telegramMessageId, deep }: IncomingMessage, onboarding: boolean) {
    await deps.conversations.append({
      role: "user",
      content: [{ type: "text", text }],
      telegramMessageId,
    });

    const turns = await deps.conversations.recent(HISTORY_LIMIT);
    const route = routeMessage({ text, deep, onboarding, followsSonnet: followsSonnet(turns) });
    let callType = route.callType;
    deps.logger?.info({ module: "router", callType, reason: route.reason }, "message routed");

    let messages: MessageParam[] = toMessageParams(turns);
    const dynamicContext = await deps.context.build({ onboarding });
    const proposals: PendingActionRow[] = [];
    const texts: string[] = [];
    let last: Message | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const { message, model } = await deps.claude.call({
        callType,
        messages,
        dynamicContext,
        tools: CHAT_TOOLS,
        toolChoice: { type: round === MAX_TOOL_ROUNDS ? "none" : "auto" },
      });
      // Review doc #13: a week plan is never written by Haiku. A misrouted plan change is
      // redone on Sonnet, and Haiku's attempt is dropped.
      if (
        isHaiku(callType) &&
        message.content.some((block) => block.type === "tool_use" && block.name === TOOL_NAMES.plan)
      ) {
        deps.logger?.info({ module: "router", from: callType }, "escalated plan change to Sonnet");
        callType = "plan_adjustment";
        round--;
        continue;
      }
      last = message;
      // ADR-003: the full block array exactly as received (thinking and tool_use included).
      const content = message.content as ContentBlockParam[];
      await deps.conversations.append({
        role: "assistant",
        content,
        model,
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      });
      const said = textOf(message.content);
      if (said) texts.push(said);

      const calls = message.content.filter((block) => block.type === "tool_use");
      if (message.stop_reason !== "tool_use" || calls.length === 0) break;

      const at = now();
      const toolContext = { chatId: deps.chatId, now: at, today: localDate(at, deps.timeZone) };
      const results: ToolResultBlockParam[] = [];
      // One after another: handlers write pending actions and may depend on each other.
      for (const call of calls) {
        const { result, outcome } = await runToolCall(deps.tools, call, toolContext, deps.logger);
        if (outcome.proposal) proposals.push(outcome.proposal);
        results.push(result);
      }
      await deps.conversations.append({ role: "user", content: results });
      // Within the loop, pass blocks back unchanged: thinking must accompany its tool_use.
      messages = [...messages, { role: "assistant", content }, { role: "user", content: results }];
    }

    return { text: last ? replyText(last, texts.join("\n\n")) : "", proposals };
  }

  // Stored as written: the model reads it in the context, so there's no call here.
  async function storeNote(payload: unknown, text: string): Promise<Reply> {
    const { activityId, field } = activityFeedbackPayload.parse(payload);
    const stored = await deps.feedback.set(activityId, { [field]: text.trim() });
    const reply = !stored
      ? "That activity is gone (deleted on Strava?), so the note wasn't saved."
      : field === "painNote"
        ? "Noted. I'll keep it in mind when planning, and ask how it is before any hard sessions."
        : "Noted, thanks.";
    return { text: reply, proposals: [] };
  }

  return {
    async handleMessage(incoming) {
      const modes = await deps.pending.live(deps.chatId, [
        "activity_feedback",
        "recap",
        "onboarding",
      ]);
      // Started by a tap on "Add a note" or "Pain: yes", so it's the athlete's latest intent.
      const note = modes.findLast((row) => row.actionType === "activity_feedback");
      if (note && (await deps.pending.consume(note.id, deps.chatId))) {
        return storeNote(note.payload, incoming.text);
      }
      const recap = modes.find((row) => row.actionType === "recap");
      if (recap && (await deps.pending.consume(recap.id, deps.chatId))) {
        const { weekStart } = recapPayload.parse(recap.payload);
        return deps.planner.generate({ feedback: incoming.text, weekStart });
      }
      return chat(
        incoming,
        modes.some((row) => row.actionType === "onboarding"),
      );
    },

    async startOnboarding() {
      await deps.pending.clear(deps.chatId, ["onboarding"]);
      await deps.pending.create({
        chatId: deps.chatId,
        actionType: "onboarding",
        payload: {},
        expiresAt: new Date(now().getTime() + ONBOARDING_TTL_MS),
      });
    },
  };
}

// The reply text for a finished call. `text` overrides the message's own text blocks (the
// orchestrator joins the text of every round).
export function replyText(
  message: Pick<Message, "content" | "stop_reason">,
  text = textOf(message.content),
): string {
  if (message.stop_reason === "refusal") {
    return text || "I can't help with that one.";
  }
  if (message.stop_reason === "max_tokens") {
    return `${text}\n\n(Reply cut off at the length limit. Ask for a shorter answer or split the question.)`.trim();
  }
  return text || "(No reply was generated. Try rephrasing.)";
}

import type {
  ContentBlockParam,
  Message,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { Logger } from "pino";
import type { ConversationStore } from "../db/conversations.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";
import { localDate } from "../utils/dates.js";
import { ONBOARDING_TTL_MS, recapPayload } from "./actions.js";
import type { Claude } from "./claude.js";
import type { ContextBuilder } from "./context.js";
import { HISTORY_LIMIT, textOf, toMessageParams } from "./history.js";
import type { Planner } from "./planner.js";
import type { Reply } from "./reply.js";
import { runToolCall, type ToolHandlers } from "./tool-handlers.js";
import { CHAT_TOOLS } from "./tools.js";

// Tool rounds per message before the model has to answer in text. Proposals are one call
// each, so a full onboarding (profile + a few markers) fits.
export const MAX_TOOL_ROUNDS = 4;

type OrchestratorDeps = {
  claude: Pick<Claude, "call">;
  conversations: ConversationStore;
  context: ContextBuilder;
  tools: ToolHandlers;
  pending: Pick<PendingActionStore, "live" | "consume" | "create" | "clear">;
  planner: Pick<Planner, "generate">;
  chatId: number;
  timeZone: string;
  logger?: Logger;
  now?: () => Date;
};

export type IncomingMessage = {
  text: string;
  telegramMessageId: number;
};

export type Orchestrator = {
  handleMessage(incoming: IncomingMessage): Promise<Reply>;
  // /onboard: the following chat messages collect the athlete's background (ADR-016).
  startOnboarding(): Promise<void>;
};

// Until the Phase 5 router: every free-text message is a `chat` call (Sonnet, low effort —
// the same policy as `plan_adjustment`, which is what mid-week plan changes are). An open
// recap turns the message into plan generation instead.
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const now = deps.now ?? (() => new Date());

  async function chat({ text, telegramMessageId }: IncomingMessage, onboarding: boolean) {
    await deps.conversations.append({
      role: "user",
      content: [{ type: "text", text }],
      telegramMessageId,
    });

    let messages: MessageParam[] = toMessageParams(await deps.conversations.recent(HISTORY_LIMIT));
    const dynamicContext = await deps.context.build({ onboarding });
    const proposals: PendingActionRow[] = [];
    const texts: string[] = [];
    let last: Message | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const { message, model } = await deps.claude.call({
        callType: "chat",
        messages,
        dynamicContext,
        tools: CHAT_TOOLS,
        toolChoice: { type: round === MAX_TOOL_ROUNDS ? "none" : "auto" },
      });
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

  return {
    async handleMessage(incoming) {
      const modes = await deps.pending.live(deps.chatId, ["recap", "onboarding"]);
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

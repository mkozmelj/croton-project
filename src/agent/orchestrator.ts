import type { ContentBlockParam, Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ConversationStore } from "../db/conversations.js";
import type { Claude } from "./claude.js";
import type { ContextBuilder } from "./context.js";
import { HISTORY_LIMIT, textOf, toMessageParams } from "./history.js";

type OrchestratorDeps = {
  claude: Pick<Claude, "call">;
  conversations: ConversationStore;
  context?: ContextBuilder;
};

export type IncomingMessage = {
  text: string;
  telegramMessageId: number;
};

export type Orchestrator = {
  // Returns the reply text to send back to the athlete.
  handleMessage(incoming: IncomingMessage): Promise<string>;
};

// Until the Phase 5 router: every free-text message is a `chat` call. The Phase 5 router replaces this choice.
export function createOrchestrator({
  claude,
  conversations,
  context,
}: OrchestratorDeps): Orchestrator {
  return {
    async handleMessage({ text, telegramMessageId }) {
      await conversations.append({
        role: "user",
        content: [{ type: "text", text }],
        telegramMessageId,
      });

      const history = toMessageParams(await conversations.recent(HISTORY_LIMIT));
      const dynamicContext = await context?.build();
      const { message, model } = await claude.call({
        callType: "chat",
        messages: history,
        ...(dynamicContext ? { dynamicContext } : {}),
      });

      await conversations.append({
        role: "assistant",
        // ADR-003: the full block array exactly as received (thinking blocks included).
        content: message.content as ContentBlockParam[],
        model,
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      });

      return replyText(message);
    },
  };
}

export function replyText(message: Pick<Message, "content" | "stop_reason">): string {
  const text = textOf(message.content);
  if (message.stop_reason === "refusal") {
    return text || "I can't help with that one.";
  }
  if (message.stop_reason === "max_tokens") {
    return `${text}\n\n(Reply cut off at the length limit. Ask for a shorter answer or split the question.)`.trim();
  }
  return text || "(No reply was generated. Try rephrasing.)";
}

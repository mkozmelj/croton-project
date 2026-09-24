import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { ConversationTurn } from "../db/conversations.js";

// spec.md §6.2: the last 20 messages go into every call.
export const HISTORY_LIMIT = 20;

// Stored turns (ADR-003) → API messages. Thinking blocks are dropped on replay: they are
// bound to the model that produced them, and a later call may run on a different model
// (e.g. Haiku in the budget's haiku_only mode). Stripping them every time keeps the
// replayed prefix deterministic, so the messages cache still hits.
export function toMessageParams(turns: readonly Pick<ConversationTurn, "role" | "content">[]) {
  const messages: MessageParam[] = [];
  for (const turn of turns) {
    const content = turn.content.filter(isReplayable);
    if (content.length === 0) continue;
    // The API requires the first message to be from the user.
    if (messages.length === 0 && turn.role !== "user") continue;
    messages.push({ role: turn.role, content });
  }
  return messages;
}

function isReplayable(block: ContentBlockParam): boolean {
  return block.type !== "thinking" && block.type !== "redacted_thinking";
}

// ADR-003: human-readable text is derived from the stored blocks at render time.
export function textOf(content: readonly (ContentBlock | ContentBlockParam)[]): string {
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();
}

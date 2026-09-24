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
  turns.forEach((turn, index) => {
    const content = turn.content.filter(isReplayable).filter(pairedWith(turns, index));
    if (content.length === 0) return;
    // The API requires the first message to be from the user.
    if (messages.length === 0 && turn.role !== "user") return;
    messages.push({ role: turn.role, content });
  });
  return messages;
}

// The API rejects a tool_use without a tool_result in the next message, and a tool_result
// without its tool_use in the one before. Unpaired blocks appear when a window cuts through
// a tool exchange or a tool round didn't finish (an error or a restart mid-round); they're
// dropped so one broken round can't break every later request.
function pairedWith(turns: readonly Pick<ConversationTurn, "role" | "content">[], index: number) {
  const idsIn = (turnIndex: number, type: "tool_use" | "tool_result") =>
    new Set(
      (turns[turnIndex]?.content ?? []).flatMap((block) =>
        block.type === type ? [block.type === "tool_use" ? block.id : block.tool_use_id] : [],
      ),
    );
  const results = idsIn(index + 1, "tool_result");
  const uses = idsIn(index - 1, "tool_use");
  return (block: ContentBlockParam) => {
    if (block.type === "tool_use") return results.has(block.id);
    if (block.type === "tool_result") return index > 0 && uses.has(block.tool_use_id);
    return true;
  };
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

import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { ConversationTurn } from "../db/conversations.js";

// The last 20 messages go into every call; older ones become memory notes (memory.ts).
export const HISTORY_LIMIT = 20;

// Stored turns (ADR-003) → API messages. Thinking blocks are dropped on replay: they are
// bound to the model that produced them, and a later call may run on a different model
// (e.g. Haiku in the budget's haiku_only mode). Stripping them every time keeps the
// replayed prefix deterministic, so the messages cache still hits.
export function toMessageParams(turns: readonly Pick<ConversationTurn, "role" | "content">[]) {
  const messages: MessageParam[] = [];
  // The API rejects a tool_use without a tool_result in the next message, and a tool_result
  // without its tool_use in the one before. Unpaired blocks appear when a window cuts through
  // a tool exchange or a tool round didn't finish (an error or a restart mid-round); they're
  // dropped so one broken round can't break every later request. Results are checked against
  // the last message actually pushed, not the previous stored turn, so a skipped turn (e.g. a
  // leading assistant turn) takes its results with it.
  let previousUses = new Set<string>();
  turns.forEach((turn, index) => {
    const results = toolIds(turns[index + 1]?.content ?? [], "tool_result");
    const content = turn.content.filter(isReplayable).filter((block) => {
      if (block.type === "tool_use") return results.has(block.id);
      if (block.type === "tool_result") return previousUses.has(block.tool_use_id);
      return true;
    });
    // The API requires the first message to be from the user.
    if (content.length === 0 || (messages.length === 0 && turn.role !== "user")) {
      previousUses = new Set();
      return;
    }
    messages.push({ role: turn.role, content });
    previousUses = toolIds(content, "tool_use");
  });
  return messages;
}

function toolIds(content: readonly ContentBlockParam[], type: "tool_use" | "tool_result") {
  return new Set(
    content.flatMap((block) =>
      block.type === type ? [block.type === "tool_use" ? block.id : block.tool_use_id] : [],
    ),
  );
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

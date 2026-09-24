import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import type { ConversationTurn, NewConversationTurn } from "../db/conversations.js";
import type { ClaudeRequest } from "./claude.js";
import { createOrchestrator, replyText } from "./orchestrator.js";

function inMemoryConversations() {
  const turns: ConversationTurn[] = [];
  return {
    turns,
    async append(turn: NewConversationTurn) {
      turns.push({
        id: turns.length + 1,
        telegramMessageId: null,
        tokensUsed: null,
        model: null,
        createdAt: new Date(),
        ...turn,
      });
    },
    async recent(limit: number) {
      return turns.slice(-limit);
    },
  };
}

const reply = {
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Rest today.", citations: null },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
} as Message;

describe("createOrchestrator().handleMessage", () => {
  it("stores both turns and sends the history to Claude", async () => {
    const conversations = inMemoryConversations();
    const calls: ClaudeRequest[] = [];
    const orchestrator = createOrchestrator({
      conversations,
      claude: {
        call: async (request) => {
          calls.push(request);
          return { message: reply, model: MODELS.sonnet, costEur: 0.001 };
        },
      },
    });

    const text = await orchestrator.handleMessage({ text: "Tired legs", telegramMessageId: 7 });

    expect(text).toBe("Rest today.");
    expect(calls[0]).toEqual({
      callType: "chat",
      messages: [{ role: "user", content: [{ type: "text", text: "Tired legs" }] }],
    });
    expect(conversations.turns.map((turn) => [turn.role, turn.content])).toEqual([
      ["user", [{ type: "text", text: "Tired legs" }]],
      ["assistant", reply.content],
    ]);
    expect(conversations.turns[1]).toMatchObject({ model: MODELS.sonnet, tokensUsed: 15 });
  });
});

describe("replyText", () => {
  it("flags a reply cut off by max_tokens", () => {
    const text = replyText({
      content: [{ type: "text", text: "Warm-up: 15 min", citations: null }],
      stop_reason: "max_tokens",
    });
    expect(text).toMatch(/^Warm-up: 15 min\n\n\(Reply cut off/);
  });

  it("never returns an empty string", () => {
    expect(replyText({ content: [], stop_reason: "end_turn" })).not.toBe("");
    expect(replyText({ content: [], stop_reason: "refusal" })).not.toBe("");
  });
});

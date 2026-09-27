import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import type { NewConversationMemory } from "../db/conversation-memories.js";
import { BudgetExceededError } from "./budget.js";
import type { ClaudeRequest } from "./claude.js";
import { createConversationMemory, MEMORY_AFTER_DAYS, transcriptLine } from "./memory.js";
import { inMemoryConversations } from "./test-helpers.js";

const NOW = new Date("2026-10-01T01:30:00Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const summaryReply = {
  content: [{ type: "text", text: "- 2026-06-12: calf niggle", citations: null }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 20 },
} as Message;

async function setup(ages: number[], fail?: Error, reply: Message = summaryReply) {
  const conversations = inMemoryConversations();
  for (const age of ages) {
    await conversations.append({ role: "user", content: [{ type: "text", text: `day -${age}` }] });
    const turn = conversations.turns.at(-1);
    if (turn) turn.createdAt = daysAgo(age);
  }
  const calls: ClaudeRequest[] = [];
  const stored: NewConversationMemory[] = [];
  const memory = createConversationMemory({
    claude: {
      call: async (request) => {
        calls.push(request);
        if (fail) throw fail;
        return { message: reply, model: MODELS.haiku, costEur: 0.001 };
      },
    },
    conversations,
    memories: {
      upsert: async (row) => {
        stored.push(row);
      },
    },
    timeZone: "Europe/Ljubljana",
    logger: pino({ level: "silent" }),
    now: () => NOW,
  });
  return { memory, conversations, calls, stored };
}

describe("createConversationMemory().consolidate", () => {
  it("summarizes turns older than 60 days on Haiku, stores the note, then deletes them", async () => {
    const { memory, conversations, calls, stored } = await setup([90, 75, 61, 30, 1]);

    const run = await memory.consolidate();

    expect(run).toEqual({ summaries: 1, turns: 3, skippedOverBudget: false });
    expect(calls[0]?.callType).toBe("conversation_summary");
    const prompt = JSON.stringify(calls[0]?.messages);
    expect(prompt).toContain("day -90");
    expect(prompt).toContain("day -61");
    expect(prompt).not.toContain("day -30");
    expect(stored).toEqual([
      {
        throughTurnId: 3,
        periodStart: "2026-07-03",
        periodEnd: "2026-08-01",
        summary: "- 2026-06-12: calf niggle",
        turnCount: 3,
      },
    ]);
    expect(conversations.turns.map((t) => t.id)).toEqual([4, 5]);
  });

  it("does nothing when no turn is old enough", async () => {
    const { memory, calls, stored } = await setup([MEMORY_AFTER_DAYS - 1]);
    expect(await memory.consolidate()).toEqual({
      summaries: 0,
      turns: 0,
      skippedOverBudget: false,
    });
    expect(calls).toEqual([]);
    expect(stored).toEqual([]);
  });

  it("keeps the turns when over budget, for next month", async () => {
    const { memory, conversations, stored } = await setup(
      [90, 80],
      new BudgetExceededError("stopped", 14),
    );
    expect((await memory.consolidate()).skippedOverBudget).toBe(true);
    expect(stored).toEqual([]);
    expect(conversations.turns).toHaveLength(2);
  });

  it("keeps the turns when the summary is cut off or refused", async () => {
    const { memory, conversations, stored } = await setup([90], undefined, {
      ...summaryReply,
      stop_reason: "max_tokens",
    });
    await expect(memory.consolidate()).rejects.toThrow("max_tokens");
    expect(stored).toEqual([]);
    expect(conversations.turns).toHaveLength(1);
  });

  it("keeps the turns when the summary call fails, so a rerun can retry", async () => {
    const { memory, conversations } = await setup([90], new Error("overloaded"));
    await expect(memory.consolidate()).rejects.toThrow("overloaded");
    expect(conversations.turns).toHaveLength(1);
  });
});

describe("transcriptLine", () => {
  it("renders text and tool calls, and skips turns with neither", () => {
    const at = new Date("2026-07-01T10:00:00Z");
    expect(
      transcriptLine(
        {
          role: "assistant",
          content: [
            { type: "text", text: "Proposed a new FTP." },
            { type: "tool_use", id: "t1", name: "propose_fitness_marker", input: {} },
          ],
          createdAt: at,
        },
        "Europe/Ljubljana",
      ),
    ).toBe("2026-07-01 Coach: Proposed a new FTP. [used propose_fitness_marker]");
    expect(
      transcriptLine(
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          createdAt: at,
        },
        "Europe/Ljubljana",
      ),
    ).toBeNull();
  });
});

import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import type { ClaudeRequest } from "./claude.js";
import { classifySessions } from "./session-classifier.js";

const reply = (sessions: unknown[]) =>
  ({
    content: [{ type: "text", text: JSON.stringify({ sessions }), citations: null }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20 },
  }) as Message;

function fakeClaude(message: Message) {
  const calls: ClaudeRequest[] = [];
  return {
    calls,
    claude: {
      call: async (request: ClaudeRequest) => {
        calls.push(request);
        return { message, model: MODELS.haiku, costEur: 0.001 };
      },
    },
  };
}

const row = (id: number, sport: string, title: string) => ({
  id,
  sport,
  title,
  durationMinutes: 50,
  structure: [{ segment: "main", description: "4x8 min Z4" }],
  notes: null,
});

describe("classifySessions", () => {
  it("keeps only types that fit the row's sport, and never a brick type", async () => {
    const { claude, calls } = fakeClaude(
      reply([
        { id: 1, session_type: "run_threshold", intensity: "hard" },
        { id: 2, session_type: "run_easy", intensity: "easy" },
        { id: 3, session_type: "brick_aerobic", intensity: "easy" },
        { id: 99, session_type: "run_easy", intensity: "easy" },
      ]),
    );
    const result = await classifySessions(claude, [
      row(1, "run", "Threshold"),
      row(2, "bike", "Easy spin"),
      row(3, "bike", "Brick"),
    ]);
    expect(calls[0]?.callType).toBe("session_classification");
    expect(calls[0]?.outputFormat?.type).toBe("json_schema");
    expect([...result]).toEqual([[1, { sessionType: "run_threshold", intensity: "hard" }]]);
  });

  it("returns nothing for a malformed reply, and makes no call without rows", async () => {
    const broken = fakeClaude({ ...reply([]), content: [] } as unknown as Message);
    expect((await classifySessions(broken.claude, [row(1, "run", "x")])).size).toBe(0);
    const idle = fakeClaude(reply([]));
    expect((await classifySessions(idle.claude, [])).size).toBe(0);
    expect(idle.calls).toHaveLength(0);
  });
});

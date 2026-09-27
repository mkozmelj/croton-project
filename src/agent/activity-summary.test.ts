import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import { createActivitySummarizer } from "./activity-summary.js";
import { BudgetExceededError } from "./budget.js";
import type { Claude, ClaudeRequest } from "./claude.js";

const context = { build: async () => "CURRENT CONTEXT\n- fake" };

function summarizer(call: Claude["call"]) {
  return createActivitySummarizer({ claude: { call }, context, timeZone: "Europe/Ljubljana" });
}

describe("createActivitySummarizer().summarize", () => {
  it("asks Haiku's activity_summary policy with the activity and the context block", async () => {
    const requests: ClaudeRequest[] = [];
    const text = await summarizer(async (request) => {
      requests.push(request);
      return {
        message: {
          content: [{ type: "text", text: "Solid tempo.", citations: null }],
          stop_reason: "end_turn",
        } as Message,
        model: MODELS.haiku,
        costEur: 0.001,
      };
    }).summarize(storedActivity());

    expect(text).toBe("Solid tempo.");
    expect(requests[0]?.callType).toBe("activity_summary");
    expect(requests[0]?.dynamicContext).toBe("CURRENT CONTEXT\n- fake");
    expect(JSON.stringify(requests[0]?.messages)).toContain('run \\"Test Tempo\\": 8.10 km');
  });

  it("returns no comment when the budget is exhausted", async () => {
    const text = await summarizer(async () => {
      throw new BudgetExceededError("stopped", 14);
    }).summarize(storedActivity());
    expect(text).toBeNull();
  });

  it("lets other errors through to the caller's error boundary", async () => {
    await expect(
      summarizer(async () => {
        throw new Error("api down");
      }).summarize(storedActivity()),
    ).rejects.toThrow("api down");
  });
});

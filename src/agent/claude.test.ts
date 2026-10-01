import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { MODELS } from "../config/env.js";
import type { UsageRecord } from "../db/llm-usage.js";
import { BudgetExceededError } from "./budget.js";
import { type ClaudeDeps, createClaude } from "./claude.js";
import { STATIC_SYSTEM_PROMPT } from "./system-prompt.js";

function fakeMessage(model: string): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Easy 40 min run today.", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2_000,
      cache_creation: null,
      server_tool_use: null,
      service_tier: "standard",
      inference_geo: null,
    },
  } as Message;
}

function setup(overrides: Partial<ClaudeDeps> & { spendEur?: number } = {}) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const recorded: UsageRecord[] = [];
  const deps: ClaudeDeps = {
    messages: {
      create: async (body) => {
        requests.push(body);
        return fakeMessage(body.model);
      },
    },
    usage: {
      record: async (row) => {
        recorded.push(row);
      },
      spendSince: async () => overrides.spendEur ?? 0,
    },
    logger: pino({ level: "silent" }),
    monthlyBudgetEur: 14,
    timeZone: "Europe/Ljubljana",
    disableThinking: false,
    now: () => new Date("2026-09-24T10:00:00Z"),
    ...overrides,
  };
  return { claude: createClaude(deps), requests, recorded };
}

const messages = [{ role: "user" as const, content: "What should I run today?" }];

describe("createClaude().call", () => {
  it("sends the cached static system prompt first", async () => {
    const { claude, requests } = setup();
    await claude.call({ callType: "chat", messages, dynamicContext: "Week 3 of base" });

    expect(requests[0]?.system).toEqual([
      { type: "text", text: STATIC_SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "Week 3 of base" },
    ]);
  });

  it("runs Sonnet call types with adaptive thinking and the ADR-005 effort", async () => {
    const { claude, requests } = setup();
    await claude.call({ callType: "plan_generation", messages });

    expect(requests[0]).toMatchObject({
      model: MODELS.sonnet,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  it("disables thinking and drops effort when the kill switch is on", async () => {
    const { claude, requests } = setup({ disableThinking: true });
    await claude.call({ callType: "plan_generation", messages });

    expect(requests[0]?.thinking).toEqual({ type: "between_tools" });
    expect(requests[0]?.output_config).toBeUndefined();
  });

  it("sends no thinking or effort parameters to Haiku", async () => {
    const { claude, requests } = setup();
    await claude.call({ callType: "activity_summary", messages });

    expect(requests[0]?.model).toBe(MODELS.haiku);
    expect(requests[0]?.thinking).toBeUndefined();
    expect(requests[0]?.output_config).toBeUndefined();
  });

  it("records usage with the local date, cache tokens and cost", async () => {
    const { claude, recorded } = setup();
    const result = await claude.call({ callType: "chat", messages });

    expect(recorded).toEqual([
      {
        date: "2026-09-24",
        model: MODELS.sonnet,
        callType: "chat",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 2_000,
        costEur: result.costEur,
      },
    ]);
    expect(result.costEur).toBeGreaterThan(0);
  });

  it("forces Haiku once the 90% threshold is reached", async () => {
    const { claude, requests } = setup({ spendEur: 12.6 });
    const result = await claude.call({ callType: "plan_generation", messages });

    expect(result.model).toBe(MODELS.haiku);
    expect(requests[0]?.model).toBe(MODELS.haiku);
    expect(requests[0]?.thinking).toBeUndefined();
  });

  it.each([13.5, 14, 30])("refuses the call without hitting the API at €%s", async (spendEur) => {
    const { claude, requests } = setup({ spendEur });

    await expect(claude.call({ callType: "chat", messages })).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(requests).toHaveLength(0);
  });

  it("reports a threshold crossed by the call", async () => {
    const onBudgetLevel = vi.fn(async () => {});
    const { claude } = setup({ spendEur: 10.4999, onBudgetLevel });
    await claude.call({ callType: "chat", messages });

    expect(onBudgetLevel).toHaveBeenCalledOnce();
    expect(onBudgetLevel).toHaveBeenCalledWith("warning", expect.any(Number));
  });
});

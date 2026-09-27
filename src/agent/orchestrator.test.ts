import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import type { ClaudeRequest } from "./claude.js";
import {
  createOrchestrator,
  FOLLOW_UP_WINDOW_MS,
  MAX_TOOL_ROUNDS,
  replyText,
} from "./orchestrator.js";
import { inMemoryConversations, inMemoryFeedback, inMemoryPending } from "./test-helpers.js";
import type { ToolHandlers } from "./tool-handlers.js";

const CHAT_ID = 42;
const NOW = new Date("2026-09-24T10:00:00Z");

const textReply = (text: string) =>
  ({
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text, citations: null },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as Message;

const toolReply = {
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "propose_goal",
      input: { event_name: "X" },
      caller: null,
    },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
} as unknown as Message;

const planToolReply = {
  ...toolReply,
  content: [
    {
      type: "tool_use",
      id: "toolu_2",
      name: "propose_week_plan",
      input: {},
      caller: null,
    },
  ],
} as unknown as Message;

function setup(replies: Message[], tools?: ToolHandlers) {
  const conversations = inMemoryConversations();
  const pending = inMemoryPending(() => NOW);
  const calls: ClaudeRequest[] = [];
  const planned: { feedback: string; weekStart?: string }[] = [];
  const feedback = inMemoryFeedback([1]);
  const orchestrator = createOrchestrator({
    conversations,
    claude: {
      call: async (request) => {
        calls.push(structuredClone(request));
        const message = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (!message) throw new Error("no reply");
        return { message, model: MODELS.sonnet, costEur: 0.001 };
      },
    },
    context: { build: async (options) => `CONTEXT ${JSON.stringify(options)}` },
    tools: tools ?? { run: async () => ({ content: "ok", isError: false }) },
    pending: pending.store,
    planner: {
      generate: async (request) => {
        planned.push(request);
        return { text: "Plan ready", proposals: [] };
      },
    },
    feedback: feedback.store,
    chatId: CHAT_ID,
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  return { orchestrator, conversations, calls, pending, planned, feedback };
}

describe("createOrchestrator().handleMessage", () => {
  it("stores both turns and sends the history, tools and context to Claude", async () => {
    const { orchestrator, conversations, calls } = setup([textReply("Rest today.")]);

    const reply = await orchestrator.handleMessage({ text: "Tired legs", telegramMessageId: 7 });

    expect(reply).toEqual({ text: "Rest today.", proposals: [] });
    expect(calls[0]).toMatchObject({
      callType: "chat",
      messages: [{ role: "user", content: [{ type: "text", text: "Tired legs" }] }],
      dynamicContext: 'CONTEXT {"onboarding":false}',
      toolChoice: { type: "auto" },
    });
    expect(calls[0]?.tools?.map((t) => t.name)).toContain("propose_week_plan");
    expect(conversations.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(conversations.turns[1]).toMatchObject({ model: MODELS.sonnet, tokensUsed: 15 });
  });

  it("runs tools, returns their results with the thinking block kept, and collects proposals", async () => {
    const proposal = {
      id: 5,
      chatId: CHAT_ID,
      actionType: "set_goal" as const,
      payload: {},
      createdAt: NOW,
      expiresAt: NOW,
    };
    const { orchestrator, calls, conversations } = setup(
      [toolReply, textReply("Proposed, tap Confirm.")],
      { run: async () => ({ content: "Proposal #5 created", isError: false, proposal }) },
    );

    const reply = await orchestrator.handleMessage({ text: "A goal", telegramMessageId: 1 });

    expect(reply).toEqual({ text: "Proposed, tap Confirm.", proposals: [proposal] });
    expect(calls[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: toolReply.content },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Proposal #5 created" }],
      },
    ]);
    expect(conversations.turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("forces a text answer after the last tool round", async () => {
    const { orchestrator, calls } = setup([toolReply]);
    await orchestrator.handleMessage({ text: "loop", telegramMessageId: 1 });
    expect(calls).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(calls.at(-1)?.toolChoice).toEqual({ type: "none" });
  });

  it("marks tool errors for the model", async () => {
    const { orchestrator, calls } = setup([toolReply, textReply("ok")], {
      run: async () => ({ content: "event_date is not in the future.", isError: true }),
    });
    await orchestrator.handleMessage({ text: "goal", telegramMessageId: 1 });
    expect(calls[1]?.messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "event_date is not in the future.",
        is_error: true,
      },
    ]);
  });

  it("treats the message after /recap as the week's feedback, once", async () => {
    const { orchestrator, pending, planned, calls } = setup([textReply("chat")]);
    await pending.store.create({
      chatId: CHAT_ID,
      actionType: "recap",
      payload: { weekStart: "2026-09-28" },
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    expect(
      (await orchestrator.handleMessage({ text: "Good week", telegramMessageId: 1 })).text,
    ).toBe("Plan ready");
    expect(planned).toEqual([{ feedback: "Good week", weekStart: "2026-09-28" }]);
    await orchestrator.handleMessage({ text: "Thanks", telegramMessageId: 2 });
    expect(calls).toHaveLength(1); // the second message is plain chat
  });

  it("stores the message after an 'Add a note' tap on the activity, without a model call", async () => {
    const { orchestrator, pending, feedback, calls, conversations } = setup([textReply("chat")]);
    // A recap is open too: the note, tapped more recently, comes first.
    for (const [actionType, payload] of [
      ["recap", { weekStart: "2026-09-28" }],
      ["activity_feedback", { activityId: 1, field: "painNote" }],
    ] as const) {
      await pending.store.create({
        chatId: CHAT_ID,
        actionType,
        payload,
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
    }

    const reply = await orchestrator.handleMessage({
      text: " left calf, tight after 5 km ",
      telegramMessageId: 1,
    });
    expect(reply.text).toContain("Noted");
    expect(feedback.rows.get(1)?.painNote).toBe("left calf, tight after 5 km");
    expect(calls).toHaveLength(0);
    expect(conversations.turns).toHaveLength(0);
    expect(pending.rows().map((row) => row.actionType)).toEqual(["recap"]);
  });

  it("says so when the activity for a note was deleted", async () => {
    const { orchestrator, pending, feedback } = setup([textReply("chat")]);
    await pending.store.create({
      chatId: CHAT_ID,
      actionType: "activity_feedback",
      payload: { activityId: 99, field: "note" },
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const reply = await orchestrator.handleMessage({ text: "felt great", telegramMessageId: 1 });
    expect(reply.text).toContain("wasn't saved");
    expect(feedback.rows.size).toBe(0);
  });

  it("adds the onboarding checklist while onboarding runs", async () => {
    const { orchestrator, calls } = setup([textReply("Q1")]);
    await orchestrator.startOnboarding();
    await orchestrator.handleMessage({ text: "hi", telegramMessageId: 1 });
    expect(calls[0]?.dynamicContext).toBe('CONTEXT {"onboarding":true}');
  });
});

describe("model routing", () => {
  it("sends small talk to Haiku and training questions to Sonnet", async () => {
    const { orchestrator, calls } = setup([textReply("ok")]);
    await orchestrator.handleMessage({ text: "Thanks!", telegramMessageId: 1 });
    await orchestrator.handleMessage({ text: "Move Friday's run to Sunday", telegramMessageId: 2 });
    expect(calls.map((c) => c.callType)).toEqual(["quick_chat", "plan_adjustment"]);
  });

  it("forces Sonnet for /deep", async () => {
    const { orchestrator, calls } = setup([textReply("ok")]);
    await orchestrator.handleMessage({ text: "hi", telegramMessageId: 1, deep: true });
    expect(calls[0]?.callType).toBe("deep");
  });

  it("keeps a short follow-up to a recent Sonnet reply on Sonnet", async () => {
    const { orchestrator, calls, conversations } = setup([textReply("ok")]);
    await conversations.append({ role: "user", content: [{ type: "text", text: "x" }] });
    await conversations.append({
      role: "assistant",
      content: [{ type: "text", text: "Shall I move it?" }],
      model: MODELS.sonnet,
    });
    const reply = conversations.turns[1];
    if (reply) reply.createdAt = new Date(NOW.getTime() - FOLLOW_UP_WINDOW_MS + 60_000);

    await orchestrator.handleMessage({ text: "yes please", telegramMessageId: 1 });
    expect(calls[0]?.callType).toBe("chat");
  });

  it("redoes a week-plan proposal from Haiku on Sonnet and drops Haiku's attempt", async () => {
    const { orchestrator, calls, conversations } = setup([planToolReply, textReply("Done.")]);
    const reply = await orchestrator.handleMessage({ text: "Why?", telegramMessageId: 1 });
    expect(calls.map((c) => c.callType)).toEqual(["knowledge_qa", "plan_adjustment"]);
    expect(reply.text).toBe("Done.");
    expect(calls[1]?.messages).toEqual(calls[0]?.messages);
    expect(conversations.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
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

describe("tool handler failures", () => {
  it("answer the tool_use with an error result instead of throwing", async () => {
    const { orchestrator, calls } = setup([toolReply, textReply("Sorry, try again.")], {
      run: async () => {
        throw new Error("db down");
      },
    });
    const reply = await orchestrator.handleMessage({ text: "goal", telegramMessageId: 1 });
    expect(reply.text).toBe("Sorry, try again.");
    expect(calls[1]?.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_1", is_error: true }),
    ]);
  });
});

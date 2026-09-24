import { describe, expect, it } from "vitest";
import { textOf, toMessageParams } from "./history.js";

describe("toMessageParams", () => {
  it("replays stored content blocks as-is", () => {
    const messages = toMessageParams([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ]);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("drops thinking blocks and turns left empty by that", () => {
    const messages = toMessageParams([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Hello" },
        ],
      },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
    ]);
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("skips leading assistant turns cut off by the history window", () => {
    const messages = toMessageParams([
      { role: "assistant", content: [{ type: "text", text: "orphan" }] },
      { role: "user", content: [{ type: "text", text: "Hi" }] },
    ]);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
  });
});

describe("textOf", () => {
  it("joins text blocks and ignores the rest", () => {
    expect(
      textOf([
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "First." },
        { type: "text", text: "Second." },
      ]),
    ).toBe("First.\n\nSecond.");
  });
});

describe("toMessageParams with tool exchanges", () => {
  it("skips a window that starts with orphaned tool results", () => {
    const messages = toMessageParams([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ]);
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "Thanks" }] }]);
  });
});

describe("toMessageParams with an unfinished tool round", () => {
  it("drops a tool_use whose result was never stored", () => {
    const messages = toMessageParams([
      { role: "user", content: [{ type: "text", text: "Set my goal" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", id: "toolu_9", name: "propose_goal", input: {} },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Hello?" }] },
    ]);
    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "On it." }] });
  });

  it("keeps complete tool exchanges", () => {
    const turns = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Goal" }] },
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "t1", name: "propose_goal", input: {} }],
      },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }],
      },
    ];
    expect(toMessageParams(turns)).toHaveLength(3);
  });
});

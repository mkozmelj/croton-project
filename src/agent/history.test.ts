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

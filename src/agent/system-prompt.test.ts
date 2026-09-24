import { describe, expect, it } from "vitest";
import { buildSystemPrompt, STATIC_SYSTEM_PROMPT } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
  it("puts the static prompt first with a 1h cache breakpoint", () => {
    const [first] = buildSystemPrompt();
    expect(first).toEqual({
      type: "text",
      text: STATIC_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });

  it("appends dynamic context after the breakpoint, uncached", () => {
    const blocks = buildSystemPrompt("Today: rest day");
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: "text", text: "Today: rest day" });
  });

  it("keeps the static prefix byte-identical across calls", () => {
    expect(buildSystemPrompt("a")[0]).toEqual(buildSystemPrompt("b")[0]);
  });

  it("has nothing that looks computed at runtime in the static prompt", () => {
    expect(STATIC_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(STATIC_SYSTEM_PROMPT).not.toContain("${");
  });
});

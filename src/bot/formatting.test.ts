import { describe, expect, it } from "vitest";
import { budgetText, splitMessage } from "./formatting.js";

describe("splitMessage", () => {
  it("leaves short text alone", () => {
    expect(splitMessage("Easy run.")).toEqual(["Easy run."]);
  });

  it("splits at paragraph boundaries under the limit", () => {
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
    expect(splitMessage(text, 40)).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("hard-splits text without break points", () => {
    const chunks = splitMessage("x".repeat(100), 40);
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 20]);
  });
});

describe("budgetText", () => {
  it("shows spend, share of the cap and a per-model breakdown", () => {
    const text = budgetText({
      monthLabel: "September 2026",
      spendEur: 1.4,
      capEur: 14,
      level: "normal",
      byModel: [
        { model: "claude-sonnet-5", calls: 12, costEur: 1.4, cacheReadInputTokens: 24_000 },
      ],
    });
    expect(text).toContain("€1.40 of €14.00 (10%)");
    expect(text).toContain("- claude-sonnet-5: 12 calls, €1.40, 24,000 cached tokens read");
  });
});

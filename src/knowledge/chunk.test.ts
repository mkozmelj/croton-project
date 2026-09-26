import { describe, expect, it } from "vitest";
import type { Block } from "./blocks.js";
import { chunkBlocks, contextPrefix, estimateTokens } from "./chunk.js";

const words = (count: number, word = "load") => Array(count).fill(word).join(" ");
const paragraph = (text: string, page?: number): Block =>
  page === undefined ? { kind: "paragraph", text } : { kind: "paragraph", text, page };
const options = { targetTokens: 100, maxTokens: 150, overlapRatio: 0.1 };

describe("chunkBlocks", () => {
  it("never lets a chunk span two sections, and tracks chapter and section", () => {
    const chunks = chunkBlocks(
      [
        { kind: "heading", level: 1, text: "Taper" },
        { kind: "heading", level: 2, text: "Volume" },
        paragraph("Cut volume.", 3),
        { kind: "heading", level: 2, text: "Intensity" },
        paragraph("Keep intensity.", 4),
      ],
      options,
    );
    expect(chunks).toEqual([
      { chapter: "Taper", section: "Volume", locator: "p. 3", content: "Cut volume." },
      { chapter: "Taper", section: "Intensity", locator: "p. 4", content: "Keep intensity." },
    ]);
  });

  it("splits a long section near the target size with a small overlap", () => {
    const sentences = (n: number) =>
      Array.from({ length: n }, (_, i) => `Sentence ${i} ${words(6)}.`).join(" ");
    const blocks = [
      paragraph(sentences(8), 1),
      paragraph(sentences(8), 2),
      paragraph(sentences(8), 3),
    ];
    const chunks = chunkBlocks(blocks, options);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(options.maxTokens + 20);
    }
    // The second chunk starts with the last sentence of the first.
    const lastSentence = chunks[0]?.content.split(/(?<=\.)\s/).at(-1) ?? "";
    expect(chunks[1]?.content.startsWith(lastSentence)).toBe(true);
    expect(chunks[1]?.locator).toBe("pp. 1-2");
  });

  it("splits an oversized paragraph by sentences", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Point ${i} ${words(10)}.`).join(" ");
    const chunks = chunkBlocks([paragraph(text)], options);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.locator === null)).toBe(true);
  });

  it("drops web-page promo sections", () => {
    const chunks = chunkBlocks(
      [
        { kind: "heading", level: 2, text: "Taper" },
        paragraph("Keep intensity."),
        { kind: "heading", level: 2, text: "Get the Newsletter" },
        paragraph("Sign up now."),
        { kind: "heading", level: 2, text: "Related Articles" },
        paragraph("Read more."),
      ],
      options,
    );
    expect(chunks.map((c) => c.content)).toEqual(["Keep intensity."]);
  });

  it("drops reference lists and similar back matter", () => {
    const chunks = chunkBlocks(
      [
        { kind: "heading", level: 2, text: "Conclusions" },
        paragraph("Train polarized."),
        { kind: "heading", level: 2, text: "References" },
        paragraph("1. Seiler S. IJSPP 2010."),
      ],
      options,
    );
    expect(chunks.map((c) => c.content)).toEqual(["Train polarized."]);
  });
});

describe("contextPrefix", () => {
  it("joins the known parts", () => {
    expect(contextPrefix("Seiler 2010", { chapter: null, section: "Intro" })).toBe(
      "Seiler 2010 — Intro",
    );
  });
});

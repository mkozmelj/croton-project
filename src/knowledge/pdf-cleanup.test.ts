import { describe, expect, it } from "vitest";
import { headingLevel, joinLines, pdfPagesToBlocks } from "./pdf-cleanup.js";

const page = (number: number, body: string) =>
  [`THE TRAINING BIBLE`, "", body, "", String(number)].join("\n");

describe("pdfPagesToBlocks", () => {
  it("drops running headers and page numbers, keeping printed pages as locators", () => {
    const pages = [
      page(41, "CHAPTER 4\n\nBase training builds the aerobic engine."),
      page(42, "Long rides stay in zone 2 for most of the time."),
      page(43, "Recovery weeks cut volume by a third."),
    ];
    expect(pdfPagesToBlocks(pages)).toEqual([
      { kind: "heading", level: 1, text: "CHAPTER 4" },
      { kind: "paragraph", text: "Base training builds the aerobic engine.", page: 41 },
      { kind: "paragraph", text: "Long rides stay in zone 2 for most of the time.", page: 42 },
      { kind: "paragraph", text: "Recovery weeks cut volume by a third.", page: 43 },
    ]);
  });

  it("rejoins hyphenated words and paragraphs split by a page break", () => {
    const pages = [
      "Athletes who reduced train-\ning volume before the race\nperformed",
      "better than those who did not.\n\nA new paragraph.",
    ];
    expect(pdfPagesToBlocks(pages)).toEqual([
      {
        kind: "paragraph",
        text: "Athletes who reduced training volume before the race performed better than those who did not.",
        page: 1,
      },
      { kind: "paragraph", text: "A new paragraph.", page: 2 },
    ]);
  });

  it("marks section headings that sit directly above their text", () => {
    const blocks = pdfPagesToBlocks(["Introduction\nPolarized training was first described."]);
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, text: "Introduction" });
  });
});

describe("heading and table handling", () => {
  it("splits off a heading glued to the previous sentence", () => {
    const blocks = pdfPagesToBlocks([
      "in accordance with the Declaration of Helsinki.\nDESIGN\n\nThe intervention lasted 9 weeks.",
    ]);
    expect(blocks).toEqual([
      { kind: "paragraph", text: "in accordance with the Declaration of Helsinki.", page: 1 },
      { kind: "heading", level: 2, text: "DESIGN" },
      { kind: "paragraph", text: "The intervention lasted 9 weeks.", page: 1 },
    ]);
  });

  it("drops table number soup", () => {
    const blocks = pdfPagesToBlocks([
      "F(3, 37) = 0.5a F(3, 37) = 2.0b 77.8 ± 3.6 143 ± 3\n\nPolarized training worked best.",
    ]);
    expect(blocks.map((b) => b.text)).toEqual(["Polarized training worked best."]);
  });
});

describe("headingLevel", () => {
  it.each([
    ["2. Methods", 2],
    ["2.1 Subjects", 3],
    ["Discussion", 2],
    ["CHAPTER 3 BASE PERIOD", 1],
    ["STATISTICAL ANALYSES", 2],
    ["HIIT", undefined],
    ["NS NS", undefined],
    ["Figure 2 Intensity distribution", undefined],
    ["The athletes trained for six weeks.", undefined],
  ])("%s → %s", (text, level) => {
    expect(headingLevel(text)).toBe(level);
  });
});

describe("joinLines", () => {
  it("keeps real hyphens before a capital", () => {
    expect(joinLines("high-", "Intensity")).toBe("high- Intensity");
    expect(joinLines("recov-", "ery")).toBe("recovery");
  });
});

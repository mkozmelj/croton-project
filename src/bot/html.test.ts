import { describe, expect, it } from "vitest";
import { esc, link, progressBar, splitMessage, stripHtml } from "./html.js";

describe("esc", () => {
  it("escapes the three characters Telegram HTML reserves", () => {
    expect(esc("HR <150 & >140")).toBe("HR &lt;150 &amp; &gt;140");
  });

  it("quotes link targets", () => {
    expect(link("open", 'https://x.test/?a=1&b="2"')).toBe(
      '<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">open</a>',
    );
  });
});

describe("splitMessage", () => {
  it("leaves short text alone", () => {
    expect(splitMessage("Easy run.")).toEqual(["Easy run."]);
  });

  it("splits at paragraph boundaries under the limit", () => {
    const text = `${"a".repeat(80)}\n\n${"b".repeat(80)}`;
    expect(splitMessage(text, 120)).toEqual(["a".repeat(80), "b".repeat(80)]);
  });

  it("hard-splits text without break points", () => {
    const chunks = splitMessage("x".repeat(250), 100);
    expect(chunks.join("")).toBe("x".repeat(250));
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it("closes tags open at a cut and reopens them in the next chunk", () => {
    const text = `<blockquote expandable>${"word ".repeat(40)}</blockquote>`;
    const chunks = splitMessage(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk.startsWith("<blockquote expandable>")).toBe(true);
      expect(chunk.endsWith("</blockquote>")).toBe(true);
    }
  });

  it("never cuts inside an entity", () => {
    const chunks = splitMessage("&amp;".repeat(40), 100);
    for (const chunk of chunks) expect(chunk).toMatch(/^(&amp;)+$/);
  });
});

describe("stripHtml", () => {
  it("drops the markup and decodes entities for the plain fallback", () => {
    expect(stripHtml('<b>FTP</b> &lt;250 W <a href="https://x.test">link</a>')).toBe(
      "FTP <250 W link",
    );
  });
});

describe("progressBar", () => {
  it("fills in proportion and clamps", () => {
    expect(progressBar(0.3)).toBe("▰▰▰▱▱▱▱▱▱▱");
    expect(progressBar(1.4)).toBe("▰".repeat(10));
  });
});

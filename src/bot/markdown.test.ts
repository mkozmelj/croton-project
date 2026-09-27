import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown.js";

describe("markdownToHtml", () => {
  it("converts emphasis, code and links", () => {
    expect(
      markdownToHtml("**Last week:** 8 h, _mostly easy_, see `Z2` and [Seiler](https://x.test/a)"),
    ).toBe(
      '<b>Last week:</b> 8 h, <i>mostly easy</i>, see <code>Z2</code> and <a href="https://x.test/a">Seiler</a>',
    );
  });

  it("escapes everything that isn't Markdown", () => {
    expect(markdownToHtml("Keep HR <150 & cadence >85")).toBe(
      "Keep HR &lt;150 &amp; cadence &gt;85",
    );
  });

  it("leaves lone asterisks and snake_case alone", () => {
    expect(markdownToHtml("3*10 min and 4*5 min, field_test run_lthr_30min")).toBe(
      "3*10 min and 4*5 min, field_test run_lthr_30min",
    );
  });

  it("turns lists into bullets and headings into bold lines", () => {
    expect(markdownToHtml("## Plan\n- Tue: tempo\n* Thu: *easy*")).toBe(
      "<b>Plan</b>\n• Tue: tempo\n• Thu: <i>easy</i>",
    );
  });

  it("keeps code fences verbatim and joins quote lines", () => {
    expect(markdownToHtml("```\n3x8 min **Z4**\n```\n> one\n> two")).toBe(
      "<pre>3x8 min **Z4**</pre>\n<blockquote>one\ntwo</blockquote>",
    );
  });

  it("produces balanced tags from overlapping markers", () => {
    const html = markdownToHtml("***both*** and **bold _mixed_ text** and **unclosed");
    expect(html).toBe("<b><i>both</i></b> and <b>bold <i>mixed</i> text</b> and **unclosed");
  });
});

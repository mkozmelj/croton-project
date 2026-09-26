import { describe, expect, it } from "vitest";
import { htmlToBlocks, jatsToBlocks, markdownToBlocks } from "./blocks.js";

describe("markdownToBlocks", () => {
  it("reads headings, paragraphs, list items and page markers", () => {
    const blocks = markdownToBlocks(
      [
        "# Tapering",
        "",
        "Volume drops",
        "by 40-60%.",
        "",
        "<!-- page 12 -->",
        "## Race week",
        "- two openers",
        "- rest the day before",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Tapering" },
      { kind: "paragraph", text: "Volume drops by 40-60%." },
      { kind: "heading", level: 2, text: "Race week" },
      { kind: "paragraph", text: "- two openers", page: 12 },
      { kind: "paragraph", text: "- rest the day before", page: 12 },
    ]);
  });
});

describe("htmlToBlocks", () => {
  it("reads only the article and skips page chrome", () => {
    const blocks = htmlToBlocks(`
      <html><body>
        <nav><a>Home</a></nav>
        <article>
          <h1>Polarized training</h1>
          <p>Most   sessions are <em>easy</em>.</p>
          <ul><li>80% easy</li><li>20% hard</li></ul>
          <script>track()</script>
        </article>
        <footer>© site</footer>
      </body></html>`);
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Polarized training" },
      { kind: "paragraph", text: "Most sessions are easy." },
      { kind: "paragraph", text: "- 80% easy" },
      { kind: "paragraph", text: "- 20% hard" },
    ]);
  });

  it("reads the biggest content container and keeps the page title", () => {
    const blocks = htmlToBlocks(`<html><head><title>Tab title</title></head><body>
      <h1>Taper guide</h1>
      <aside><article><p>Teaser</p></article></aside>
      <div class="entry-content"><p>Cut volume by 40-60% over two weeks.</p></div>
    </body></html>`);
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "Taper guide" },
      { kind: "paragraph", text: "Cut volume by 40-60% over two weeks." },
    ]);
  });

  it("walks into list items that wrap paragraphs", () => {
    const blocks = htmlToBlocks("<body><ol><li><p>First</p><p>Second</p></li></ol></body>");
    expect(blocks.map((b) => b.text)).toEqual(["First", "Second"]);
  });
});

describe("jatsToBlocks", () => {
  it("reads title, abstract and nested sections, without citations, figures or references", () => {
    const blocks = jatsToBlocks(`<article><front><article-meta><title-group>
      <article-title>The paradox</article-title></title-group>
      <abstract><sec><title>Background</title><p>Load protects.</p></sec></abstract>
      </article-meta></front>
      <body><sec><title>Methods</title><p>We measured load.<xref>12</xref></p>
        <fig><caption><p>Figure text</p></caption></fig>
        <sec><title>Subjects</title><list><list-item><p>Rugby players</p></list-item></list></sec>
      </sec></body>
      <back><ref-list><ref>Smith 2001</ref></ref-list></back></article>`);
    expect(blocks).toEqual([
      { kind: "heading", level: 1, text: "The paradox" },
      { kind: "heading", level: 2, text: "Abstract" },
      { kind: "heading", level: 3, text: "Background" },
      { kind: "paragraph", text: "Load protects." },
      { kind: "heading", level: 2, text: "Methods" },
      { kind: "paragraph", text: "We measured load." },
      { kind: "heading", level: 3, text: "Subjects" },
      { kind: "paragraph", text: "- Rugby players" },
    ]);
  });
});

import { type HTMLElement, NodeType, parse } from "node-html-parser";

// The format-neutral shape every extractor produces (ADR-014 "normalize to Markdown"): a flat
// run of headings and paragraphs. `page` is the printed page a paragraph starts on, when the
// source has pages; the chunker turns it into the citation locator.
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string; page?: number };

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

// Markdown (athlete notes, Kindle highlights, cleaned-up text). `<!-- page N -->` comments set
// the page for the paragraphs after them, so hand-made notes can carry locators too.
export function markdownToBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let page: number | undefined;
  let paragraph: string[] = [];
  const flush = () => {
    const text = collapse(paragraph.join(" "));
    if (text)
      blocks.push(
        page === undefined ? { kind: "paragraph", text } : { kind: "paragraph", text, page },
      );
    paragraph = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const pageMarker = line.match(/^\s*<!--\s*page\s+(\d+)\s*-->\s*$/i);
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    const listItem = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (pageMarker) {
      flush();
      page = Number(pageMarker[1]);
    } else if (heading?.[1] && heading[2]) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: collapse(heading[2]) });
    } else if (!line.trim()) {
      flush();
    } else if (listItem) {
      // Each list item stands alone, so a long list can be split between items.
      flush();
      paragraph.push(`- ${listItem[1]}`);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

const SKIPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "svg",
  "figure",
  "iframe",
]);
const PARAGRAPH_TAGS = new Set([
  "p",
  "li",
  "blockquote",
  "pre",
  "dt",
  "dd",
  "td",
  "th",
  "figcaption",
]);

const CONTENT_SELECTORS = "article, main, [class*=entry-content], [class*=post-content]";

// HTML articles and EPUB chapters. Saved web pages carry menus, teasers and footers, so only
// the content container with the most text is read (a blog sidebar is also an <article>).
export function htmlToBlocks(html: string): Block[] {
  const root = parse(html, { comment: false });
  const candidates = root.querySelectorAll(CONTENT_SELECTORS);
  const body =
    candidates.reduce<HTMLElement | null>(
      (best, element) => (!best || element.text.length > best.text.length ? element : best),
      null,
    ) ??
    root.querySelector("body") ??
    root;
  const blocks: Block[] = [];
  const walk = (element: HTMLElement) => {
    for (const node of element.childNodes) {
      if (node.nodeType === NodeType.TEXT_NODE) {
        // Loose text directly inside a container (common in EPUBs).
        const text = collapse(node.text);
        if (text) blocks.push({ kind: "paragraph", text });
        continue;
      }
      if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
      const child = node as HTMLElement;
      const tag = child.rawTagName?.toLowerCase() ?? "";
      if (SKIPPED_TAGS.has(tag)) continue;
      const heading = tag.match(/^h([1-6])$/);
      if (heading?.[1]) {
        const text = collapse(child.text);
        if (text) blocks.push({ kind: "heading", level: Number(heading[1]), text });
      } else if (PARAGRAPH_TAGS.has(tag) && !hasBlockChildren(child)) {
        const text = collapse(child.text);
        if (text) blocks.push({ kind: "paragraph", text: tag === "li" ? `- ${text}` : text });
      } else {
        walk(child);
      }
    }
  };
  walk(body);
  // The page title often sits above the content container or in a skipped <header>.
  if (body !== root && !blocks.some((block) => block.kind === "heading" && block.level === 1)) {
    const title = collapse(
      root.querySelector("h1")?.text ?? root.querySelector("title")?.text ?? "",
    );
    if (title) blocks.unshift({ kind: "heading", level: 1, text: title });
  }
  return blocks;
}

// An <li> or <blockquote> that wraps its own <p>s or lists is walked, not flattened.
function hasBlockChildren(element: HTMLElement): boolean {
  return element.childNodes.some((node) => {
    if (node.nodeType !== NodeType.ELEMENT_NODE) return false;
    const tag = (node as HTMLElement).rawTagName?.toLowerCase() ?? "";
    return tag === "p" || tag === "ul" || tag === "ol" || tag === "div" || /^h[1-6]$/.test(tag);
  });
}

// JATS XML (open-access papers from Europe PMC / PMC): nested <sec>s give the heading levels.
// Figures, tables, references and back matter are left out; citation markers are dropped.
const JATS_SKIPPED = new Set(["table-wrap", "fig", "ref-list", "back", "xref", "label", "graphic"]);

export function jatsToBlocks(xml: string): Block[] {
  const root = parse(xml, { comment: false });
  const blocks: Block[] = [];
  const title = root.querySelector("article-meta article-title");
  if (title) blocks.push({ kind: "heading", level: 1, text: collapse(title.text) });

  const textOf = (element: HTMLElement): string => {
    // Citation markers ("…injury.1 2") would stick to the words; drop them first.
    for (const xref of element.querySelectorAll("xref")) xref.remove();
    return collapse(element.text);
  };
  const walk = (element: HTMLElement, depth: number) => {
    for (const node of element.childNodes) {
      if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
      const child = node as HTMLElement;
      const tag = child.rawTagName?.toLowerCase() ?? "";
      if (JATS_SKIPPED.has(tag)) continue;
      if (tag === "title") {
        const text = textOf(child);
        if (text) blocks.push({ kind: "heading", level: Math.min(depth + 1, 6), text });
      } else if (tag === "p") {
        const text = textOf(child);
        if (text) blocks.push({ kind: "paragraph", text });
      } else if (tag === "list-item") {
        const text = textOf(child);
        if (text) blocks.push({ kind: "paragraph", text: `- ${text}` });
      } else {
        walk(child, tag === "sec" ? depth + 1 : depth);
      }
    }
  };
  const abstract = root.querySelector("abstract");
  if (abstract) {
    blocks.push({ kind: "heading", level: 2, text: "Abstract" });
    walk(abstract, 1);
  }
  const body = root.querySelector("body");
  if (body) walk(body, 0);
  return blocks;
}

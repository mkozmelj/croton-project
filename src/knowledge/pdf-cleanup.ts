import type { Block } from "./blocks.js";

// ADR-014 cleanup pass for `pdftotext` output (text PDFs and OCR'd scans alike): running
// headers/footers and page numbers out, hyphenation undone, paragraphs rejoined across page
// breaks, likely headings marked. Input is one string per PDF page (pdftotext's \f split).

const EDGE_LINES = 2;
// A line at the top/bottom of at least this share of pages is a running header or footer.
const RUNNING_SHARE = 0.3;
const RUNNING_MIN_PAGES = 3;

const KNOWN_SECTIONS =
  /^(abstract|introduction|background|methods?|materials and methods|results|discussion|conclusions?|practical applications|summary|key points|limitations|references|bibliography|acknowledge?ments?|funding|conflicts? of interest|competing interests)$/i;

type Page = { lines: string[]; printed?: number };

const normalizeEdge = (line: string) =>
  line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const pageNumber = (line: string) => {
  const match = line.trim().match(/^(?:page\s+)?(\d{1,4})$/i);
  return match ? Number(match[1]) : undefined;
};

export function pdfPagesToBlocks(rawPages: readonly string[]): Block[] {
  const pages = stripEdges(
    rawPages.map((text) => text.split(/\r?\n/).map((line) => line.trimEnd())),
  );
  const blocks: Block[] = [];
  let lastPrinted: number | undefined;
  pages.forEach((page, index) => {
    // Printed page numbers where the page shows one, counted on from the last one otherwise,
    // the PDF page index as a last resort: a citation should match the book in hand.
    const number = page.printed ?? (lastPrinted === undefined ? index + 1 : lastPrinted + 1);
    if (page.printed !== undefined || lastPrinted !== undefined) lastPrinted = number;
    for (const text of paragraphs(page.lines)) {
      const previous = blocks.at(-1);
      if (previous?.kind === "paragraph" && continues(previous.text, text)) {
        previous.text = joinLines(previous.text, text);
        continue;
      }
      const heading = headingLevel(text);
      blocks.push(
        heading
          ? { kind: "heading", level: heading, text }
          : { kind: "paragraph", text, page: number },
      );
    }
  });
  return blocks.filter((block) => block.kind === "heading" || isProse(block.text));
}

// Table cells and statistics come out of pdftotext as number soup ("F(3, 37) = 0.5a 77.8 ± 3.6
// …"): they only add noise to retrieval, so paragraphs that are mostly not letters are dropped.
export function isProse(text: string): boolean {
  const visible = text.replace(/\s/g, "");
  if (visible.length < 3) return false;
  const letters = visible.replace(/[^\p{L}]/gu, "").length;
  return letters / visible.length >= 0.6;
}

function stripEdges(pages: string[][]): Page[] {
  const edgeIndexes = (lines: string[]) => {
    const filled = lines.flatMap((line, i) => (line.trim() ? [i] : []));
    return [...filled.slice(0, EDGE_LINES), ...filled.slice(-EDGE_LINES)];
  };
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const seen = new Set(edgeIndexes(lines).map((i) => normalizeEdge(lines[i] ?? "")));
    for (const key of seen) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(RUNNING_MIN_PAGES, pages.length * RUNNING_SHARE);
  const running = (line: string) => {
    const key = normalizeEdge(line);
    return key.length > 0 && key !== "#" && (counts.get(key) ?? 0) >= threshold;
  };

  return pages.map((lines) => {
    const drop = new Set<number>();
    let printed: number | undefined;
    for (const i of edgeIndexes(lines)) {
      const line = lines[i] ?? "";
      const number = pageNumber(line);
      if (number !== undefined) {
        printed ??= number;
        drop.add(i);
      } else if (running(line)) {
        // A running header with the page number in it ("12   CHAPTER 2 BASE TRAINING").
        const embedded = line.trim().match(/^(\d{1,4})\s{2,}|\s{2,}(\d{1,4})$/);
        if (embedded) printed ??= Number(embedded[1] ?? embedded[2]);
        drop.add(i);
      }
    }
    const kept = lines.filter((_, i) => !drop.has(i));
    return printed === undefined ? { lines: kept } : { lines: kept, printed };
  });
}

// Blank lines separate paragraphs; lines inside one are joined, hyphenation undone.
function paragraphs(lines: string[]): string[] {
  const result: string[] = [];
  let current = "";
  for (const raw of [...lines, ""]) {
    const line = raw.trim();
    if (!line) {
      if (current) result.push(current);
      current = "";
      continue;
    }
    // Headings often touch their neighbours without a blank line: a heading-looking line
    // stands alone when it follows a finished sentence or is followed directly by text.
    const afterSentence = current && /[.!?]$/.test(current) && headingLevel(line);
    const beforeText = current && headingLevel(current) && !/[.,;:]$/.test(current);
    if (afterSentence || beforeText) {
      result.push(current);
      current = line;
      continue;
    }
    current = current ? joinLines(current, line) : line;
  }
  return result;
}

export function joinLines(left: string, right: string): string {
  // "train-" + "ing" → "training"; "high-" + "Intensity" keeps its hyphen.
  if (/[a-z]-$/i.test(left) && /^[a-z]/.test(right)) return `${left.slice(0, -1)}${right}`;
  return `${left} ${right}`;
}

// A page break mid-sentence: the next page's text starts lowercase after an open sentence.
function continues(previous: string, next: string): boolean {
  return !/[.!?:"”)]$/.test(previous) && /^[a-z]/.test(next);
}

export function headingLevel(text: string): number | undefined {
  if (text.length > 80 || /[.,;:]$/.test(text) || /^(figure|fig\.|table)\s/i.test(text))
    return undefined;
  const words = text.split(/\s+/);
  if (words.length > 10) return undefined;
  if (/^chapter\s+\d+/i.test(text)) return 1;
  const numbered = text.match(/^(\d+(?:\.\d+)*)\.?\s+[A-Z]/);
  if (numbered?.[1]) return Math.min(1 + numbered[1].split(".").length, 4);
  if (KNOWN_SECTIONS.test(text)) return 2;
  // ALL-CAPS section titles ("STATISTICAL ANALYSES"); short all-caps words are more often
  // abbreviations or table headers ("HIIT", "NS NS").
  const letters = text.replace(/[^A-Za-z]/g, "");
  const longestWord = Math.max(...words.map((word) => word.replace(/[^A-Za-z]/g, "").length));
  if (letters === letters.toUpperCase() && longestWord >= 6) return 2;
  return undefined;
}

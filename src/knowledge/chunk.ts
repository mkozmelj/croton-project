import { createHash } from "node:crypto";
import type { Block } from "./blocks.js";

// ADR-014: heading-aware chunks of ~500-800 tokens with ~10% overlap. A chunk never spans two
// sections; a long section is split between paragraphs (sentences, for a huge paragraph).

export type ChunkOptions = {
  targetTokens: number;
  maxTokens: number;
  overlapRatio: number;
};

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 700,
  maxTokens: 900,
  overlapRatio: 0.1,
};

export type Chunk = {
  chapter: string | null;
  section: string | null;
  locator: string | null;
  content: string;
};

// Back matter and web-page promos that only add noise to retrieval.
const SKIPPED_SECTIONS =
  /\b(references|bibliography|acknowledge?ments?|funding|conflicts? of interest|competing interests|author contributions|about the authors?|newsletter|related (articles|posts|content)|share this|free .*trial|subscribe|leave a (reply|comment)|comments|sponsored by|you (may|might) also like|unlock your potential)\b|^index$|^the ultimate .* guide$/i;

// ~4 characters per token for English prose; only used for sizing.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

type Piece = { text: string; page?: number; overlap?: boolean };

export function chunkBlocks(blocks: readonly Block[], options = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const chunks: Chunk[] = [];
  let chapter: string | null = null;
  let section: string | null = null;
  let skipping = false;
  let buffer: Piece[] = [];

  const tokens = (pieces: Piece[]) => pieces.reduce((sum, p) => sum + estimateTokens(p.text), 0);
  const emit = () => {
    if (buffer.some((piece) => !piece.overlap)) {
      chunks.push({
        chapter,
        section,
        locator: locatorFor(buffer),
        content: buffer.map((piece) => piece.text).join("\n\n"),
      });
    }
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      emit();
      buffer = [];
      if (block.level <= 1) {
        chapter = block.text;
        section = null;
      } else {
        section = block.text;
      }
      skipping = SKIPPED_SECTIONS.test(block.text);
      continue;
    }
    if (skipping) continue;
    for (const text of splitOversized(block.text, options.maxTokens)) {
      const piece: Piece = block.page === undefined ? { text } : { text, page: block.page };
      if (buffer.length > 0 && tokens(buffer) + estimateTokens(text) > options.targetTokens) {
        emit();
        buffer = overlapTail(buffer, options.targetTokens * options.overlapRatio);
      }
      buffer.push(piece);
    }
  }
  emit();
  return chunks;
}

// The end of the previous chunk, repeated at the start of the next one.
function overlapTail(pieces: Piece[], budget: number): Piece[] {
  const last = pieces.at(-1);
  if (!last || budget <= 0) return [];
  const sentences = splitSentences(last.text);
  const tail: string[] = [];
  let used = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const sentence = sentences[i] ?? "";
    if (used + estimateTokens(sentence) > budget && tail.length > 0) break;
    tail.unshift(sentence);
    used += estimateTokens(sentence);
    if (used > budget) break;
  }
  const text = tail.join(" ");
  return [
    last.page === undefined ? { text, overlap: true } : { text, page: last.page, overlap: true },
  ];
}

function splitOversized(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const parts: string[] = [];
  let current = "";
  for (const sentence of splitSentences(text)) {
    if (current && estimateTokens(`${current} ${sentence}`) > maxTokens) {
      parts.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) parts.push(current);
  // A single "sentence" longer than the limit (tables, OCR soup) is cut hard.
  const limit = maxTokens * 4;
  return parts.flatMap((part) =>
    part.length <= limit
      ? [part]
      : Array.from({ length: Math.ceil(part.length / limit) }, (_, i) =>
          part.slice(i * limit, (i + 1) * limit),
        ),
  );
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter(Boolean);
}

function locatorFor(pieces: Piece[]): string | null {
  const pages = pieces.flatMap((piece) => (piece.page === undefined ? [] : [piece.page]));
  if (pages.length === 0) return null;
  const first = Math.min(...pages);
  const last = Math.max(...pages);
  return first === last ? `p. ${first}` : `pp. ${first}-${last}`;
}

// "Source — Chapter — Section", embedded with the chunk so a short passage still carries the
// topic of the section it came from.
export function contextPrefix(source: string, chunk: Pick<Chunk, "chapter" | "section">): string {
  return [source, chunk.chapter, chunk.section].filter(Boolean).join(" — ");
}

export function embeddingText(source: string, chunk: Chunk): string {
  return `${contextPrefix(source, chunk)}\n\n${chunk.content}`;
}

// The idempotency key (ADR-009 style): same source text and chunking → same hash, no new row.
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

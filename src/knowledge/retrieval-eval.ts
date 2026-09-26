import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LITERATURE_SOURCE_TYPES } from "../db/schema.js";
import { markdownToBlocks } from "./blocks.js";
import { contentHash } from "./chunk.js";
import { prepareChunks } from "./ingest.js";
import { buildVectorIndex, type IndexedChunk } from "./vector-index.js";

// ADR-014 retrieval eval: a fixture corpus (short notes on the open sources), questions with the
// source that should answer them, and top-k recall through the real chunker and cosine search.
// Vectors come from a committed cache (eval-fixtures/embeddings.json) so the test needs no
// network; `npm run eval:embed` refreshes it after the chunking or the fixture changes.

const FIXTURES = fileURLToPath(new URL("./eval-fixtures/", import.meta.url));
export const EMBEDDINGS_FILE = `${FIXTURES}embeddings.json`;
// The search tool returns 5 passages by default, so the right source has to be in the top 5.
export const EVAL_K = 5;

const evalSchema = z.object({
  sources: z.record(
    z.string(),
    z.object({ source: z.string(), type: z.enum(LITERATURE_SOURCE_TYPES) }),
  ),
  questions: z.array(z.object({ query: z.string(), source: z.string() })),
});

const cacheSchema = z.object({
  model: z.string(),
  // key → base64 int8 vector. Cosine similarity ignores scale, so int8 keeps the ranking.
  vectors: z.record(z.string(), z.string()),
});
export type EmbeddingCache = z.infer<typeof cacheSchema>;

export type EvalCase = {
  // What gets embedded, keyed by its hash.
  texts: Map<string, string>;
  chunks: (IndexedChunk & { key: string })[];
  questions: { query: string; source: string; key: string }[];
};

export const keyOf = (text: string) => contentHash(text).slice(0, 16);

export async function loadEvalCase(): Promise<EvalCase> {
  const manifest = evalSchema.parse(JSON.parse(await readFile(`${FIXTURES}eval.json`, "utf8")));
  const texts = new Map<string, string>();
  const chunks: EvalCase["chunks"] = [];
  for (const [file, { source, type }] of Object.entries(manifest.sources)) {
    const blocks = markdownToBlocks(await readFile(`${FIXTURES}corpus/${file}`, "utf8"));
    for (const chunk of prepareChunks(blocks, source, type)) {
      const key = keyOf(chunk.text);
      texts.set(key, chunk.text);
      chunks.push({ ...chunk, id: chunks.length + 1, source, key });
    }
  }
  const questions = manifest.questions.map((q) => {
    const key = keyOf(q.query);
    texts.set(key, q.query);
    return { ...q, key };
  });
  return { texts, chunks, questions };
}

export async function readCache(): Promise<EmbeddingCache | null> {
  try {
    return cacheSchema.parse(JSON.parse(await readFile(EMBEDDINGS_FILE, "utf8")));
  } catch {
    return null;
  }
}

export function quantize(vector: readonly number[]): string {
  const max = Math.max(...vector.map(Math.abs)) || 1;
  return Buffer.from(Int8Array.from(vector, (v) => Math.round((v / max) * 127)).buffer).toString(
    "base64",
  );
}

export function dequantize(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  return Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
}

export type RecallReport = {
  recall: number;
  top1: number;
  misses: { query: string; expected: string; got: string[] }[];
};

export function measureRecall(
  evalCase: EvalCase,
  vector: (key: string) => number[],
  k: number,
): RecallReport {
  const index = buildVectorIndex(
    evalCase.chunks.map((chunk) => ({ ...chunk, embedding: vector(chunk.key) })),
  );
  let hits = 0;
  let top1 = 0;
  const misses: RecallReport["misses"] = [];
  for (const question of evalCase.questions) {
    const sources = index.search(vector(question.key), k).map((result) => result.source);
    if (sources[0] === question.source) top1++;
    if (sources.includes(question.source)) hits++;
    else misses.push({ query: question.query, expected: question.source, got: sources });
  }
  const total = evalCase.questions.length;
  return { recall: hits / total, top1: top1 / total, misses };
}

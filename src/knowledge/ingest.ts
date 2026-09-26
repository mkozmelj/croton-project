import type { LiteratureStore, NewLiteratureChunk } from "../db/literature.js";
import type { LITERATURE_SOURCE_TYPES } from "../db/schema.js";
import type { Block } from "./blocks.js";
import { type Chunk, chunkBlocks, contentHash, embeddingText } from "./chunk.js";
import type { Embedder } from "./embeddings.js";

// ADR-014 ingest: blocks → chunks → embeddings for new chunks only → upsert → drop the rows the
// source no longer produces. Re-running on an unchanged file embeds nothing and writes nothing new.

export type SourceType = (typeof LITERATURE_SOURCE_TYPES)[number];

export type PreparedChunk = Chunk & { text: string; hash: string };

export type IngestResult = {
  chunks: number;
  embedded: number;
  unchanged: number;
  removed: number;
};

type IngestDeps = {
  store: Pick<LiteratureStore, "hashesFor" | "upsert" | "removeStale">;
  embedder: Embedder;
};

export class IngestError extends Error {
  override readonly name = "IngestError";
}

export function prepareChunks(
  blocks: readonly Block[],
  source: string,
  sourceType: SourceType,
): PreparedChunk[] {
  const seen = new Set<string>();
  return chunkBlocks(blocks).flatMap((chunk) => {
    const text = embeddingText(source, chunk);
    // The locator and type are part of the key, so fixing a page number replaces the row.
    const hash = contentHash(`${sourceType}\n${chunk.locator ?? ""}\n${text}`);
    // A passage repeated verbatim (a boxed summary, a reprinted table) is stored once.
    if (seen.has(hash)) return [];
    seen.add(hash);
    return [{ ...chunk, text, hash }];
  });
}

export async function ingest(
  deps: IngestDeps,
  request: { blocks: readonly Block[]; source: string; sourceType: SourceType },
): Promise<IngestResult> {
  const { source, sourceType } = request;
  const prepared = prepareChunks(request.blocks, source, sourceType);
  if (prepared.length === 0) {
    throw new IngestError("No text found to ingest; nothing was changed.");
  }

  const existing = await deps.store.hashesFor(source, deps.embedder.model);
  const fresh = prepared.filter((chunk) => !existing.has(chunk.hash));
  const vectors = await deps.embedder.embed(fresh.map((chunk) => chunk.text));
  const rows: NewLiteratureChunk[] = fresh.map((chunk, i) => ({
    source,
    sourceType,
    chapter: chunk.chapter,
    section: chunk.section,
    locator: chunk.locator,
    content: chunk.content,
    contentHash: chunk.hash,
    embeddingModel: deps.embedder.model,
    embedding: vectors[i] ?? [],
  }));
  if (rows.some((row) => row.embedding.length === 0)) {
    throw new IngestError("An embedding came back empty; nothing was written.");
  }
  await deps.store.upsert(rows);
  // Only after the new rows are in: a failed run never leaves the source with fewer chunks.
  const removed = await deps.store.removeStale(
    source,
    prepared.map((chunk) => chunk.hash),
  );
  return {
    chunks: prepared.length,
    embedded: fresh.length,
    unchanged: prepared.length - fresh.length,
    removed,
  };
}

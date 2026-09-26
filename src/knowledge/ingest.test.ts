import { describe, expect, it } from "vitest";
import type { NewLiteratureChunk } from "../db/literature.js";
import type { Block } from "./blocks.js";
import type { Embedder } from "./embeddings.js";
import { IngestError, ingest } from "./ingest.js";

// Mirrors the table's unique (source, content_hash) upsert.
function inMemoryStore() {
  const rows = new Map<string, NewLiteratureChunk>();
  const key = (source: string, hash: string) => `${source}\u0000${hash}`;
  return {
    rows,
    async hashesFor(source: string, model: string) {
      return new Set(
        [...rows.values()]
          .filter((r) => r.source === source && r.embeddingModel === model)
          .map((r) => r.contentHash),
      );
    },
    async upsert(batch: readonly NewLiteratureChunk[]) {
      for (const row of batch) rows.set(key(row.source, row.contentHash), row);
    },
    async removeStale(source: string, keep: readonly string[]) {
      let removed = 0;
      for (const [k, row] of rows) {
        if (row.source === source && !keep.includes(row.contentHash)) {
          rows.delete(k);
          removed++;
        }
      }
      return removed;
    },
  };
}

function fakeEmbedder(model = "test-model") {
  const embedded: string[] = [];
  const embedder: Embedder = {
    model,
    async embed(texts) {
      embedded.push(...texts);
      return texts.map((text) => [text.length, 1]);
    },
  };
  return { embedder, embedded };
}

const blocks: Block[] = [
  { kind: "heading", level: 2, text: "Taper" },
  { kind: "paragraph", text: "Reduce volume 41-60% over two weeks.", page: 3 },
  { kind: "heading", level: 2, text: "Intensity" },
  { kind: "paragraph", text: "Keep intensity high during the taper.", page: 4 },
];
const request = { blocks, source: "Bosquet 2007", sourceType: "paper" as const };

describe("ingest", () => {
  it("embeds each chunk with its context prefix and stores it", async () => {
    const store = inMemoryStore();
    const { embedder, embedded } = fakeEmbedder();
    const result = await ingest({ store, embedder }, request);
    expect(result).toEqual({ chunks: 2, embedded: 2, unchanged: 0, removed: 0 });
    expect(embedded[0]).toBe("Bosquet 2007 — Taper\n\nReduce volume 41-60% over two weeks.");
    expect([...store.rows.values()][0]).toMatchObject({
      section: "Taper",
      locator: "p. 3",
      sourceType: "paper",
      embeddingModel: "test-model",
    });
  });

  it("is idempotent: a re-run embeds and adds nothing", async () => {
    const store = inMemoryStore();
    const first = fakeEmbedder();
    await ingest({ store, embedder: first.embedder }, request);
    const second = fakeEmbedder();
    const result = await ingest({ store, embedder: second.embedder }, request);
    expect(result).toEqual({ chunks: 2, embedded: 0, unchanged: 2, removed: 0 });
    expect(second.embedded).toEqual([]);
    expect(store.rows.size).toBe(2);
  });

  it("replaces changed chunks and removes the stale ones", async () => {
    const store = inMemoryStore();
    await ingest({ store, embedder: fakeEmbedder().embedder }, request);
    const edited = blocks.map((b) =>
      b.kind === "paragraph" && b.page === 4 ? { ...b, text: "Keep some intensity." } : b,
    );
    const result = await ingest(
      { store, embedder: fakeEmbedder().embedder },
      { ...request, blocks: edited },
    );
    expect(result).toEqual({ chunks: 2, embedded: 1, unchanged: 1, removed: 1 });
    expect([...store.rows.values()].map((r) => r.content)).toContain("Keep some intensity.");
    expect(store.rows.size).toBe(2);
  });

  it("re-embeds everything under a new embedding model", async () => {
    const store = inMemoryStore();
    await ingest({ store, embedder: fakeEmbedder("old").embedder }, request);
    const result = await ingest({ store, embedder: fakeEmbedder("new").embedder }, request);
    expect(result.embedded).toBe(2);
    expect([...store.rows.values()].every((r) => r.embeddingModel === "new")).toBe(true);
  });

  it("refuses an empty document without touching the store", async () => {
    const store = inMemoryStore();
    await ingest({ store, embedder: fakeEmbedder().embedder }, request);
    await expect(
      ingest({ store, embedder: fakeEmbedder().embedder }, { ...request, blocks: [] }),
    ).rejects.toBeInstanceOf(IngestError);
    expect(store.rows.size).toBe(2);
  });
});

import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { LiteratureChunkRow } from "../db/literature.js";
import type { Embedder } from "./embeddings.js";
import { createLiteratureSearch } from "./literature-search.js";
import { buildVectorIndex } from "./vector-index.js";

const logger = pino({ level: "silent" });

const row = (id: number, embedding: number[]): LiteratureChunkRow => ({
  id,
  source: `S${id}`,
  chapter: null,
  section: null,
  locator: null,
  content: `chunk ${id}`,
  embedding,
});

describe("buildVectorIndex", () => {
  it("ranks by cosine similarity regardless of vector length", () => {
    const index = buildVectorIndex([row(1, [1, 0]), row(2, [10, 10]), row(3, [0, 5])]);
    const results = index.search([0, 1], 2);
    expect(results.map((r) => r.id)).toEqual([3, 2]);
    expect(results[0]?.score).toBeCloseTo(1);
    expect(results[1]?.score).toBeCloseTo(Math.SQRT1_2);
  });
});

function setup(embedder: Embedder | null = { model: "m", embed: async () => [[0, 1]] }) {
  let rows = [row(1, [1, 0]), row(2, [0, 1])];
  let loads = 0;
  const store = {
    async loadForModel() {
      loads++;
      return rows;
    },
    async signature() {
      return `${rows.length}:${rows.at(-1)?.id ?? 0}`;
    },
  };
  const search = createLiteratureSearch({ store, embedder, logger });
  return {
    search,
    loads: () => loads,
    setRows: (next: LiteratureChunkRow[]) => {
      rows = next;
    },
  };
}

describe("createLiteratureSearch", () => {
  it("searches the loaded chunks", async () => {
    const { search } = setup();
    expect(await search.load()).toBe(2);
    const outcome = await search.search("anything", 1);
    expect(outcome).toMatchObject({ status: "ok", results: [{ id: 2 }] });
  });

  it("reloads when an ingest changed the table, and only then", async () => {
    const { search, loads, setRows } = setup();
    await search.load();
    await search.search("q", 1);
    expect(loads()).toBe(1);
    setRows([row(1, [1, 0]), row(2, [0, 1]), row(3, [0, 1])]);
    const outcome = await search.search("q", 3);
    expect(loads()).toBe(2);
    expect(outcome.status === "ok" && outcome.results).toHaveLength(3);
  });

  it("reports not configured without an embedder and empty without chunks", async () => {
    expect(await setup(null).search.search("q", 1)).toEqual({ status: "not_configured" });
    const { search, setRows } = setup();
    setRows([]);
    expect(await search.search("q", 1)).toEqual({ status: "empty" });
  });
});

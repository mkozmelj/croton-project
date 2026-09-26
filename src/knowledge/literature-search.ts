import type { Logger } from "pino";
import type { LiteratureStore } from "../db/literature.js";
import type { Embedder } from "./embeddings.js";
import { buildVectorIndex, type ScoredChunk, type VectorIndex } from "./vector-index.js";

// The runtime side of ADR-014: chunks for the current embedding model are held in memory,
// loaded at startup and reloaded when the table changes (an ingest run while the app is up).

export type SearchOutcome =
  | { status: "ok"; results: ScoredChunk[] }
  | { status: "not_configured" }
  | { status: "empty" };

export type LiteratureSearch = {
  load(): Promise<number>;
  search(query: string, limit: number): Promise<SearchOutcome>;
};

type SearchDeps = {
  store: Pick<LiteratureStore, "loadForModel" | "signature">;
  // Absent without OPENAI_API_KEY: search reports "not configured" (ADR-014).
  embedder: Embedder | null;
  logger: Logger;
};

export function createLiteratureSearch(deps: SearchDeps): LiteratureSearch {
  const log = deps.logger.child({ module: "literature" });
  let index: VectorIndex | null = null;
  let loadedSignature: string | null = null;

  async function load(model: string): Promise<number> {
    const signature = await deps.store.signature(model);
    const rows = await deps.store.loadForModel(model);
    index = buildVectorIndex(rows);
    loadedSignature = signature;
    log.info({ chunks: index.size, model }, "literature index loaded");
    return index.size;
  }

  return {
    async load() {
      if (!deps.embedder) {
        log.info("literature search disabled (OPENAI_API_KEY unset)");
        return 0;
      }
      return load(deps.embedder.model);
    },

    async search(query, limit) {
      const { embedder } = deps;
      if (!embedder) return { status: "not_configured" };
      if (!index || (await deps.store.signature(embedder.model)) !== loadedSignature) {
        await load(embedder.model);
      }
      if (!index || index.size === 0) return { status: "empty" };
      const [vector] = await embedder.embed([query]);
      if (!vector) return { status: "empty" };
      return { status: "ok", results: index.search(vector, limit) };
    },
  };
}

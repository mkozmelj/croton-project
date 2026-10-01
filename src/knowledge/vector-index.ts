// In-memory cosine search (ADR-014; no pgvector while the corpus fits in memory).
// Vectors are normalized once on load, so a query is one dot product per chunk.

export type IndexedChunk = {
  id: number;
  source: string;
  chapter: string | null;
  section: string | null;
  locator: string | null;
  content: string;
};

export type ScoredChunk = IndexedChunk & { score: number };

export type VectorIndex = {
  readonly size: number;
  search(query: readonly number[], limit: number): ScoredChunk[];
};

function normalized(vector: readonly number[]): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

export function buildVectorIndex(
  rows: readonly (IndexedChunk & { embedding: readonly number[] })[],
): VectorIndex {
  const entries = rows.map(({ embedding, ...chunk }) => ({ chunk, vector: normalized(embedding) }));
  return {
    size: entries.length,
    search(query, limit) {
      const q = normalized(query);
      const scored: ScoredChunk[] = [];
      for (const { chunk, vector } of entries) {
        if (vector.length !== q.length) continue;
        let score = 0;
        for (let i = 0; i < q.length; i++) score += (q[i] ?? 0) * (vector[i] ?? 0);
        scored.push({ ...chunk, score });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}

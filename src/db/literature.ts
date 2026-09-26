import { and, count, eq, max, notInArray, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { literatureChunks } from "./schema.js";

export type NewLiteratureChunk = Omit<typeof literatureChunks.$inferInsert, "id" | "createdAt">;
export type LiteratureChunkRow = Pick<
  typeof literatureChunks.$inferSelect,
  "id" | "source" | "chapter" | "section" | "locator" | "content" | "embedding"
>;

export type SourceSummary = { source: string; sourceType: string; chunks: number };

// ADR-014. Written only by the ingest CLI; read into memory by the literature search.
export type LiteratureStore = {
  // Hashes of the source's rows already embedded with `model`: those need no new embedding.
  hashesFor(source: string, model: string): Promise<Set<string>>;
  upsert(rows: readonly NewLiteratureChunk[]): Promise<void>;
  // Deletes the source's rows whose hash isn't in `keep` (the text changed or moved).
  removeStale(source: string, keep: readonly string[]): Promise<number>;
  loadForModel(model: string): Promise<LiteratureChunkRow[]>;
  // Changes whenever rows for the model are added, removed or re-embedded.
  signature(model: string): Promise<string>;
  sources(): Promise<SourceSummary[]>;
};

// Neon's HTTP driver sends one request per statement; keep each insert well under its limits.
const UPSERT_BATCH = 50;

export function createLiteratureStore(db: Database): LiteratureStore {
  return {
    async hashesFor(source, model) {
      const rows = await db
        .select({ hash: literatureChunks.contentHash })
        .from(literatureChunks)
        .where(
          and(eq(literatureChunks.source, source), eq(literatureChunks.embeddingModel, model)),
        );
      return new Set(rows.map((row) => row.hash));
    },

    async upsert(rows) {
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        await db
          .insert(literatureChunks)
          .values(rows.slice(i, i + UPSERT_BATCH))
          .onConflictDoUpdate({
            target: [literatureChunks.source, literatureChunks.contentHash],
            set: {
              sourceType: sql`excluded.source_type`,
              chapter: sql`excluded.chapter`,
              section: sql`excluded.section`,
              locator: sql`excluded.locator`,
              content: sql`excluded.content`,
              embeddingModel: sql`excluded.embedding_model`,
              embedding: sql`excluded.embedding`,
            },
          });
      }
    },

    async removeStale(source, keep) {
      const conditions = [eq(literatureChunks.source, source)];
      if (keep.length > 0) conditions.push(notInArray(literatureChunks.contentHash, [...keep]));
      const deleted = await db
        .delete(literatureChunks)
        .where(and(...conditions))
        .returning({ id: literatureChunks.id });
      return deleted.length;
    },

    async loadForModel(model) {
      return db
        .select({
          id: literatureChunks.id,
          source: literatureChunks.source,
          chapter: literatureChunks.chapter,
          section: literatureChunks.section,
          locator: literatureChunks.locator,
          content: literatureChunks.content,
          embedding: literatureChunks.embedding,
        })
        .from(literatureChunks)
        .where(eq(literatureChunks.embeddingModel, model))
        .orderBy(literatureChunks.id);
    },

    async signature(model) {
      const [row] = await db
        .select({ rows: count(), lastId: max(literatureChunks.id) })
        .from(literatureChunks)
        .where(eq(literatureChunks.embeddingModel, model));
      return `${row?.rows ?? 0}:${row?.lastId ?? 0}`;
    },

    async sources() {
      const rows = await db
        .select({
          source: literatureChunks.source,
          sourceType: literatureChunks.sourceType,
          chunks: count(),
        })
        .from(literatureChunks)
        .groupBy(literatureChunks.source, literatureChunks.sourceType)
        .orderBy(literatureChunks.source);
      return rows.map((row) => ({ ...row, chunks: Number(row.chunks) }));
    },
  };
}

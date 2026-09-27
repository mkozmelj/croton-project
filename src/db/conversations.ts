import { and, asc, desc, lt, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { conversations } from "./schema.js";

export type ConversationTurn = typeof conversations.$inferSelect;
export type NewConversationTurn = typeof conversations.$inferInsert;

export type ConversationStore = {
  append(turn: NewConversationTurn): Promise<void>;
  // The most recent `limit` turns, oldest first.
  recent(limit: number): Promise<ConversationTurn[]>;
  // Up to `limit` turns created before `before`, oldest first (the memory job).
  olderThan(before: Date, limit: number): Promise<ConversationTurn[]>;
  // Deletes the turns created before `before` with an id up to `throughId`.
  deleteThrough(throughId: number, before: Date): Promise<void>;
};

export function createConversationStore(db: Database): ConversationStore {
  return {
    async append(turn) {
      await db.insert(conversations).values(turn);
    },

    async recent(limit) {
      const rows = await db
        .select()
        .from(conversations)
        .orderBy(desc(conversations.createdAt), desc(conversations.id))
        .limit(limit);
      return rows.reverse();
    },

    async olderThan(before, limit) {
      return db
        .select()
        .from(conversations)
        .where(lt(conversations.createdAt, before))
        .orderBy(asc(conversations.createdAt), asc(conversations.id))
        .limit(limit);
    },

    async deleteThrough(throughId, before) {
      await db
        .delete(conversations)
        .where(and(lte(conversations.id, throughId), lt(conversations.createdAt, before)));
    },
  };
}

import { desc } from "drizzle-orm";
import type { Database } from "./client.js";
import { conversations } from "./schema.js";

export type ConversationTurn = typeof conversations.$inferSelect;
export type NewConversationTurn = typeof conversations.$inferInsert;

export type ConversationStore = {
  append(turn: NewConversationTurn): Promise<void>;
  // The most recent `limit` turns, oldest first.
  recent(limit: number): Promise<ConversationTurn[]>;
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
  };
}

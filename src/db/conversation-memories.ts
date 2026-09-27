import { desc } from "drizzle-orm";
import type { Database } from "./client.js";
import { conversationMemories } from "./schema.js";

export type ConversationMemory = typeof conversationMemories.$inferSelect;
export type NewConversationMemory = Omit<typeof conversationMemories.$inferInsert, "id">;

export type ConversationMemoryStore = {
  // ADR-009: upsert on `through_turn_id`.
  upsert(memory: NewConversationMemory): Promise<void>;
  // The latest `limit` memories, oldest first.
  recent(limit: number): Promise<ConversationMemory[]>;
};

export function createConversationMemoryStore(db: Database): ConversationMemoryStore {
  return {
    async upsert(memory) {
      const { throughTurnId: _key, ...changes } = memory;
      await db
        .insert(conversationMemories)
        .values(memory)
        .onConflictDoUpdate({ target: conversationMemories.throughTurnId, set: changes });
    },

    async recent(limit) {
      const rows = await db
        .select()
        .from(conversationMemories)
        .orderBy(desc(conversationMemories.throughTurnId))
        .limit(limit);
      return rows.reverse();
    },
  };
}

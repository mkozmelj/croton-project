import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { Database } from "./client.js";
import { type PENDING_ACTION_TYPES, pendingActions } from "./schema.js";

export type PendingActionType = (typeof PENDING_ACTION_TYPES)[number];
export type PendingActionRow = typeof pendingActions.$inferSelect;

export type NewPendingAction = {
  chatId: number;
  actionType: PendingActionType;
  payload: unknown;
  expiresAt: Date;
};

// ADR-007. Rows past `expires_at` are never returned; they're deleted lazily.
export type PendingActionStore = {
  create(action: NewPendingAction): Promise<PendingActionRow>;
  // Live rows for the chat, oldest first, optionally of some types only.
  live(chatId: number, types?: readonly PendingActionType[]): Promise<PendingActionRow[]>;
  // Deletes the row and returns it if it was live — a second call (a double tap on
  // Confirm) returns null, so an action can't run twice.
  consume(id: number, chatId: number): Promise<PendingActionRow | null>;
  // Puts a consumed row back (same id) after its execution failed, so it can be retried.
  restore(row: PendingActionRow): Promise<void>;
  // Deletes every live row of these types for the chat (e.g. a newer plan supersedes the old).
  clear(chatId: number, types: readonly PendingActionType[]): Promise<void>;
};

export function createPendingActionStore(db: Database, now = () => new Date()): PendingActionStore {
  return {
    async create(action) {
      await db.delete(pendingActions).where(lte(pendingActions.expiresAt, now()));
      const [row] = await db.insert(pendingActions).values(action).returning();
      if (!row) throw new Error("pending action insert returned no row");
      return row;
    },

    async live(chatId, types) {
      const conditions = [eq(pendingActions.chatId, chatId), gt(pendingActions.expiresAt, now())];
      if (types) conditions.push(inArray(pendingActions.actionType, [...types]));
      return db
        .select()
        .from(pendingActions)
        .where(and(...conditions))
        .orderBy(asc(pendingActions.id));
    },

    async consume(id, chatId) {
      // A single DELETE … RETURNING, so two concurrent taps can't both get the row.
      const [row] = await db
        .delete(pendingActions)
        .where(
          and(
            eq(pendingActions.id, id),
            eq(pendingActions.chatId, chatId),
            gt(pendingActions.expiresAt, now()),
          ),
        )
        .returning();
      return row ?? null;
    },

    async restore(row) {
      await db.insert(pendingActions).values(row).onConflictDoNothing();
    },

    async clear(chatId, types) {
      await db
        .delete(pendingActions)
        .where(
          and(eq(pendingActions.chatId, chatId), inArray(pendingActions.actionType, [...types])),
        );
    },
  };
}

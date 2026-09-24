import type { ConversationTurn, NewConversationTurn } from "../db/conversations.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";

export function inMemoryConversations() {
  const turns: ConversationTurn[] = [];
  return {
    turns,
    async append(turn: NewConversationTurn) {
      turns.push({
        id: turns.length + 1,
        telegramMessageId: null,
        tokensUsed: null,
        model: null,
        createdAt: new Date(),
        ...turn,
      });
    },
    async recent(limit: number) {
      return turns.slice(-limit);
    },
  };
}

// Mirrors the DB store's semantics: expiry, single consume, restore with the same id.
export function inMemoryPending(now = () => new Date()) {
  let rows: PendingActionRow[] = [];
  let nextId = 1;
  const isLive = (row: PendingActionRow) => row.expiresAt > now();
  const store: PendingActionStore = {
    async create(action) {
      const row = { ...action, id: nextId++, createdAt: now() };
      rows.push(row);
      return row;
    },
    async live(chatId, types) {
      return rows.filter(
        (r) => r.chatId === chatId && isLive(r) && (!types || types.includes(r.actionType)),
      );
    },
    async consume(id, chatId) {
      const row = rows.find((r) => r.id === id && r.chatId === chatId && isLive(r));
      rows = rows.filter((r) => r !== row);
      return row ?? null;
    },
    async restore(row) {
      if (!rows.some((r) => r.id === row.id)) rows.push(row);
    },
    async clear(chatId, types) {
      rows = rows.filter((r) => !(r.chatId === chatId && types.includes(r.actionType)));
    },
  };
  return { store, rows: () => rows };
}

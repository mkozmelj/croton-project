import type { ActivityFeedback, ActivityFeedbackStore } from "../db/activity-feedback.js";
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
    async olderThan(before: Date, limit: number) {
      return turns.filter((turn) => turn.createdAt < before).slice(0, limit);
    },
    async deleteThrough(throughId: number, before: Date) {
      const kept = turns.filter((turn) => !(turn.id <= throughId && turn.createdAt < before));
      turns.splice(0, turns.length, ...kept);
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

// Mirrors the DB store: a write for an activity that doesn't exist returns null.
export function inMemoryFeedback(activityIds: readonly number[] = [1], now = () => new Date()) {
  const rows = new Map<number, ActivityFeedback>();
  const store: ActivityFeedbackStore = {
    async set(activityId, fields) {
      if (!activityIds.includes(activityId)) return null;
      const row: ActivityFeedback = {
        id: activityId,
        activityId,
        rpe: null,
        rpeSource: null,
        feel: null,
        pain: null,
        painNote: null,
        note: null,
        createdAt: now(),
        ...rows.get(activityId),
        ...fields,
        updatedAt: now(),
      };
      rows.set(activityId, row);
      return row;
    },
    async get(activityId) {
      return rows.get(activityId) ?? null;
    },
    async forActivities(ids) {
      return new Map([...rows].filter(([id]) => ids.includes(id)));
    },
  };
  return { store, rows };
}

import { Bot } from "grammy";
import type { Update } from "grammy/types";

// A Bot that never needs getMe; outgoing API calls are captured instead of sent.
export function offlineBot() {
  const bot = new Bot("123456:test-token", {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    },
  });
  const calls: { method: string; payload: unknown }[] = [];
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    // Every captured call "succeeds"; tests only inspect `calls`, never the result.
    return { ok: true, result: true } as unknown as Awaited<ReturnType<typeof prev>>;
  });
  return { bot, calls };
}

export function textUpdate(chatId: number, text: string, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "Athlete" },
      from: { id: chatId, is_bot: false, first_name: "Athlete" },
      text,
    },
  };
}

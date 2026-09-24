import type { Context, MiddlewareFn } from "grammy";
import type { Logger } from "pino";

// ADR-006: only the athlete's chat gets through. Everything else is dropped silently —
// no reply, so strangers can't tell the bot is listening. The chat ID is logged so the
// athlete can find their own ID in the logs when setting TELEGRAM_AUTHORIZED_CHAT_ID.
export function authorizedChatOnly(
  authorizedChatId: number,
  logger: Logger,
): MiddlewareFn<Context> {
  const log = logger.child({ module: "access-control" });
  return async (ctx, next) => {
    if (ctx.chat?.id === authorizedChatId) {
      await next();
      return;
    }
    log.warn(
      { chatId: ctx.chat?.id, updateId: ctx.update.update_id },
      "dropped unauthorized update",
    );
  };
}

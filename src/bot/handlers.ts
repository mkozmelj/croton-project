import type { Bot, Context, MiddlewareFn } from "grammy";
import type { Logger } from "pino";
import { BudgetExceededError } from "../agent/budget.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import { budgetRefusalText, failureText, splitMessage } from "./formatting.js";

// Telegram clears the "typing…" indicator after ~5 s; refresh it while Claude works.
const TYPING_REFRESH_MS = 4_500;

// Catches everything below it: the error is logged and the athlete gets a message
// instead of silence (stack doc §5). Errors never reach grammy's webhook adapter, which
// would answer 500 and make Telegram redeliver the update.
export function errorBoundary(logger: Logger): MiddlewareFn<Context> {
  const log = logger.child({ module: "bot" });
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      log.error({ err: error, updateId: ctx.update.update_id }, "update handling failed");
      await ctx.reply(failureText()).catch((replyError: unknown) => {
        log.error({ err: replyError }, "failed to send failure message");
      });
    }
  };
}

export function registerMessageHandlers(
  bot: Bot,
  { orchestrator }: { orchestrator: Orchestrator },
) {
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply("Unknown command. Try /budget.");
      return;
    }

    const stopTyping = keepTyping(ctx);
    let reply: string;
    try {
      reply = await orchestrator.handleMessage({
        text: ctx.message.text,
        telegramMessageId: ctx.message.message_id,
      });
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      reply = budgetRefusalText();
    } finally {
      stopTyping();
    }

    for (const chunk of splitMessage(reply)) await ctx.reply(chunk);
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("I can only read text messages for now.");
  });
}

function keepTyping(ctx: Context): () => void {
  const send = () => {
    ctx.replyWithChatAction("typing").catch(() => {
      // Cosmetic only; a failed indicator must not fail the reply.
    });
  };
  send();
  const timer = setInterval(send, TYPING_REFRESH_MS);
  return () => clearInterval(timer);
}

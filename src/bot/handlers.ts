import { type Bot, type Context, InlineKeyboard, type MiddlewareFn } from "grammy";
import type { Logger } from "pino";
import type { ActionExecutor } from "../agent/action-executor.js";
import { BudgetExceededError } from "../agent/budget.js";
import type { IncomingMessage, Orchestrator } from "../agent/orchestrator.js";
import type { Reply } from "../agent/reply.js";
import type { PendingActionRow } from "../db/pending-actions.js";
import { GoogleCalendarError } from "../integrations/google/calendar.js";
import { GoogleAuthError } from "../integrations/google/oauth.js";
import { TokenRefreshError } from "../integrations/token-refresh.js";
import { actionResultText, budgetRefusalText, failureText, modelText } from "./formatting.js";
import { esc, splitMessage } from "./html.js";
import { proposalHtml } from "./proposal-html.js";

// Telegram clears the "typing…" indicator after ~5 s; refresh it while Claude works.
const TYPING_REFRESH_MS = 4_500;

// Callback data of the Confirm/Cancel buttons: `pa:<pending action id>:ok|no`.
const PROPOSAL_CALLBACK = /^pa:(\d+):(ok|no)$/;

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

export function proposalKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard().text("✅ Confirm", `pa:${id}:ok`).text("✖️ Cancel", `pa:${id}:no`);
}

// The proposal as rendered from its payload, with its buttons on the last chunk.
export function proposalMessages(row: PendingActionRow) {
  const chunks = splitMessage(proposalHtml(row));
  return chunks.map((text, index) => ({
    text,
    ...(index === chunks.length - 1 ? { reply_markup: proposalKeyboard(row.id) } : {}),
  }));
}

// The reply text is the model's Markdown (or plain text); proposals are rendered by code.
export async function replyWithProposals(ctx: Context, reply: Reply): Promise<void> {
  for (const chunk of splitMessage(modelText(reply.text))) await ctx.reply(chunk);
  for (const proposal of reply.proposals) {
    for (const { text, ...options } of proposalMessages(proposal)) await ctx.reply(text, options);
  }
}

// Runs `work` with the typing indicator on; an over-budget refusal becomes a reply.
export async function withTyping<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  const send = () => {
    ctx.replyWithChatAction("typing").catch(() => {
      // Cosmetic only; a failed indicator must not fail the reply.
    });
  };
  send();
  const timer = setInterval(send, TYPING_REFRESH_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

type HandlerDeps = { orchestrator: Orchestrator; executor: ActionExecutor };

export function registerMessageHandlers(bot: Bot, { orchestrator, executor }: HandlerDeps) {
  async function answer(ctx: Context, incoming: IncomingMessage) {
    let reply: Reply;
    try {
      reply = await withTyping(ctx, () => orchestrator.handleMessage(incoming));
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      await ctx.reply(budgetRefusalText());
      return;
    }
    await replyWithProposals(ctx, reply);
  }

  // `/deep <message>` forces Sonnet for one message (ADR-005).
  bot.command("deep", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await ctx.reply("Send /deep followed by your question, e.g. /deep am I ready for a 70.3?");
      return;
    }
    await answer(ctx, { text, telegramMessageId: ctx.msg.message_id, deep: true });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply("Unknown command. /start lists them.");
      return;
    }
    await answer(ctx, { text: ctx.message.text, telegramMessageId: ctx.message.message_id });
  });

  // ADR-007: the confirmation step. Everything it needs is in the pending_actions row, so a
  // button tapped after a restart still works.
  bot.callbackQuery(PROPOSAL_CALLBACK, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {
      // Only stops the button's loading spinner.
    });
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const id = Number(ctx.match[1]);

    let result: string;
    try {
      result =
        ctx.match[2] === "ok"
          ? await withTyping(ctx, () => executor.confirm(id, chatId))
          : await executor.cancel(id, chatId);
    } catch (error) {
      // The row was restored: keep the buttons so Confirm can be tapped again.
      if (error instanceof GoogleAuthError) {
        await ctx.reply(
          "⚠️ Google Calendar access has expired or was revoked. Send /reauth calendar, then tap Confirm again.",
        );
        return;
      }
      if (error instanceof TokenRefreshError) {
        await ctx.reply(
          "⚠️ Google didn't answer when renewing calendar access. Nothing was lost; tap Confirm to retry in a bit.",
        );
        return;
      }
      if (error instanceof GoogleCalendarError) {
        await ctx.reply(
          `⚠️ Booking failed (${esc(error.message)}). Nothing was lost; tap Confirm to retry.`,
        );
        return;
      }
      throw error;
    }
    await ctx.editMessageReplyMarkup().catch(() => {
      // The message may be too old to edit; the row is consumed either way.
    });
    await ctx.reply(actionResultText(result));
  });

  bot.on("message", async (ctx) => {
    await ctx.reply("I can only read text messages for now.");
  });
}

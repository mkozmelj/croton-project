import type { Bot } from "grammy";
import type { Logger } from "pino";
import type { ActionExecutor } from "../agent/action-executor.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import { authorizedChatOnly } from "./access-control.js";
import { COMMANDS, type CommandDeps, registerCommands } from "./commands.js";
import { type FeedbackHandlerDeps, registerFeedbackHandlers } from "./feedback.js";
import { errorBoundary, registerMessageHandlers } from "./handlers.js";
import { htmlParseMode } from "./parse-mode.js";

export const TELEGRAM_WEBHOOK_PATH = "/webhook/telegram";

type BotDeps = CommandDeps & {
  authorizedChatId: number;
  orchestrator: Orchestrator;
  executor: ActionExecutor;
  activityFeedback: FeedbackHandlerDeps;
  logger: Logger;
};

// Messages, plus button taps: Confirm/Cancel (ADR-007) and activity feedback (ADR-018).
const ALLOWED_UPDATES = ["message", "callback_query"] as const;

// Middleware order matters: error boundary, then access control (ADR-006) before any handler.
export function configureBot(bot: Bot, deps: BotDeps): Bot {
  bot.api.config.use(htmlParseMode(deps.logger));
  bot.use(errorBoundary(deps.logger));
  bot.use(authorizedChatOnly(deps.authorizedChatId, deps.logger));
  registerCommands(bot, deps);
  registerFeedbackHandlers(bot, deps.activityFeedback);
  registerMessageHandlers(bot, deps);
  return bot;
}

export type BotTransport =
  | { mode: "polling" }
  | { mode: "webhook"; appUrl: string; secretToken: string };

type StartOptions = {
  transport: BotTransport;
  authorizedChatId: number;
  logger: Logger;
};

// Dev: long polling, no public URL needed. Prod: webhook registered on every boot, with the
// secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token (ADR-012). The URL never
// contains the bot token.
export async function startBot(bot: Bot, { transport, authorizedChatId, logger }: StartOptions) {
  const log = logger.child({ module: "bot" });
  await bot.init();
  // Scoped to the athlete's chat, so the command menu isn't advertised to anyone else.
  await bot.api.setMyCommands(COMMANDS, { scope: { type: "chat", chat_id: authorizedChatId } });

  if (transport.mode === "webhook") {
    const url = new URL(TELEGRAM_WEBHOOK_PATH, transport.appUrl).toString();
    await bot.api.setWebhook(url, {
      secret_token: transport.secretToken,
      allowed_updates: ALLOWED_UPDATES,
    });
    log.info({ url }, "telegram webhook registered");
    return;
  }

  // bot.start() deletes any registered webhook first, then polls until bot.stop().
  void bot
    .start({
      allowed_updates: ALLOWED_UPDATES,
      onStart: (info) => log.info({ username: info.username }, "telegram long polling started"),
    })
    .catch((error: unknown) => log.fatal({ err: error }, "telegram long polling stopped"));
}

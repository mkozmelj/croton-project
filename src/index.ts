import Anthropic from "@anthropic-ai/sdk";
import { Bot } from "grammy";
import { createClaude } from "./agent/claude.js";
import { createOrchestrator } from "./agent/orchestrator.js";
import { budgetAlertText } from "./bot/formatting.js";
import { createNotifier } from "./bot/notifier.js";
import { type BotTransport, configureBot, startBot } from "./bot/setup.js";
import { registerTelegramWebhook } from "./bot/webhook.js";
import { env } from "./config/env.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { createConversationStore } from "./db/conversations.js";
import { createUsageStore } from "./db/llm-usage.js";
import { connectionStringSecrets, createLogger } from "./logging/logger.js";
import { buildServer } from "./server.js";

const logger = createLogger({
  level: env.LOG_LEVEL,
  secrets: [
    env.TELEGRAM_BOT_TOKEN,
    env.ANTHROPIC_API_KEY,
    ...connectionStringSecrets(env.DATABASE_URL),
    ...(env.TELEGRAM_WEBHOOK_SECRET ? [env.TELEGRAM_WEBHOOK_SECRET] : []),
  ],
});

const transport: BotTransport =
  env.NODE_ENV === "production" && env.APP_URL && env.TELEGRAM_WEBHOOK_SECRET
    ? { mode: "webhook", appUrl: env.APP_URL, secretToken: env.TELEGRAM_WEBHOOK_SECRET }
    : { mode: "polling" };

const db = createDatabase(env.DATABASE_URL);
const usage = createUsageStore(db);
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
const notifier = createNotifier(bot.api, env.TELEGRAM_AUTHORIZED_CHAT_ID, logger);

const claude = createClaude({
  messages: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).messages,
  usage,
  logger,
  monthlyBudgetEur: env.MONTHLY_LLM_BUDGET_EUR,
  timeZone: env.TIMEZONE,
  disableThinking: env.DISABLE_THINKING,
  onBudgetLevel: (level, spendEur) =>
    notifier.notify(budgetAlertText(level, spendEur, env.MONTHLY_LLM_BUDGET_EUR)),
});

configureBot(bot, {
  authorizedChatId: env.TELEGRAM_AUTHORIZED_CHAT_ID,
  orchestrator: createOrchestrator({ claude, conversations: createConversationStore(db) }),
  usage,
  monthlyBudgetEur: env.MONTHLY_LLM_BUDGET_EUR,
  timeZone: env.TIMEZONE,
  logger,
});

const app = buildServer({ logger });
if (transport.mode === "webhook") {
  registerTelegramWebhook(app, { bot, secretToken: transport.secretToken });
}

// Railway sends SIGTERM on every redeploy — let in-flight requests finish first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    Promise.all([app.close(), bot.isRunning() ? bot.stop() : undefined]).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      },
    );
  });
}

try {
  await runMigrations(db);
  logger.info({ module: "db" }, "migrations applied");
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  await startBot(bot, { transport, authorizedChatId: env.TELEGRAM_AUTHORIZED_CHAT_ID, logger });
  logger.info({ transport: transport.mode, thinkingDisabled: env.DISABLE_THINKING }, "started");
} catch (error) {
  logger.fatal({ err: error }, "startup failed");
  process.exit(1);
}

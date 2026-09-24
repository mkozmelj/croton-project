import Anthropic from "@anthropic-ai/sdk";
import { Bot } from "grammy";
import { createActivitySummarizer } from "./agent/activity-summary.js";
import { createClaude } from "./agent/claude.js";
import { createContextBuilder } from "./agent/context.js";
import { createOrchestrator } from "./agent/orchestrator.js";
import type { StravaConnectDeps } from "./bot/commands.js";
import {
  activityFailureText,
  budgetAlertText,
  jobFailureText,
  jobRecoveredText,
  serverFailureText,
  stravaConnectedText,
  stravaRevokedText,
} from "./bot/formatting.js";
import { createNotifier } from "./bot/notifier.js";
import { type BotTransport, configureBot, startBot } from "./bot/setup.js";
import { registerTelegramWebhook } from "./bot/webhook.js";
import { env } from "./config/env.js";
import { createActivityStore } from "./db/activities.js";
import { createAthleteProfileStore } from "./db/athlete-profile.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { createConversationStore } from "./db/conversations.js";
import { createHealthMetricsStore } from "./db/health-metrics.js";
import { createUsageStore } from "./db/llm-usage.js";
import { createOAuthStateStore } from "./db/oauth-states.js";
import { createOAuthTokenStore } from "./db/oauth-tokens.js";
import {
  createIntervalsClient,
  intervalsBasicCredentials,
} from "./integrations/intervals/client.js";
import { createWellnessSync } from "./integrations/intervals/wellness-sync.js";
import { createTokenCipher } from "./integrations/oauth-crypto.js";
import { createStravaActivitySync } from "./integrations/strava/activity-sync.js";
import {
  registerStravaAuthRoutes,
  STRAVA_AUTH_CALLBACK_PATH,
  STRAVA_AUTH_START_PATH,
} from "./integrations/strava/auth-routes.js";
import { createStravaClient } from "./integrations/strava/client.js";
import { createStravaAuth } from "./integrations/strava/oauth.js";
import { registerStravaWebhook } from "./integrations/strava/webhook.js";
import { connectionStringSecrets, createLogger } from "./logging/logger.js";
import { type Job, type Scheduler, startScheduler } from "./scheduler/cron.js";
import { buildServer } from "./server.js";
import { createBackgroundTasks } from "./utils/background.js";

const logger = createLogger({
  level: env.LOG_LEVEL,
  secrets: [
    env.TELEGRAM_BOT_TOKEN,
    env.ANTHROPIC_API_KEY,
    ...connectionStringSecrets(env.DATABASE_URL),
    ...[
      env.TELEGRAM_WEBHOOK_SECRET,
      env.STRAVA_CLIENT_SECRET,
      env.STRAVA_WEBHOOK_VERIFY_TOKEN,
      env.TOKEN_ENCRYPTION_KEY,
      env.INTERVALS_API_KEY,
      env.INTERVALS_API_KEY && intervalsBasicCredentials(env.INTERVALS_API_KEY),
    ].filter((secret) => secret !== undefined),
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

const activities = createActivityStore(db);
const health = createHealthMetricsStore(db);
const context = createContextBuilder({
  profile: createAthleteProfileStore(db),
  activities,
  health,
  timeZone: env.TIMEZONE,
});
const tasks = createBackgroundTasks({
  logger,
  onError: (label) =>
    notifier.notify(
      label.startsWith("strava")
        ? activityFailureText()
        : `Background task ${label} failed. It's logged.`,
    ),
});

// Local dev has no APP_URL; Strava always accepts localhost as a callback domain.
const publicUrl = env.APP_URL ?? `http://localhost:${env.PORT}`;
const app = buildServer({
  logger,
  onServerError: (route) => notifier.notify(serverFailureText(route)),
});
if (transport.mode === "webhook") {
  registerTelegramWebhook(app, { bot, secretToken: transport.secretToken });
}

let stravaConnect: StravaConnectDeps | undefined;
if (env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY) {
  const tokens = createOAuthTokenStore(db, createTokenCipher(env.TOKEN_ENCRYPTION_KEY));
  const states = createOAuthStateStore(db);
  const auth = createStravaAuth({
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
    redirectUri: new URL(STRAVA_AUTH_CALLBACK_PATH, publicUrl).toString(),
    tokens,
  });
  registerStravaAuthRoutes(app, {
    auth,
    states,
    onConnected: () => notifier.notify(stravaConnectedText()),
  });
  stravaConnect = {
    states,
    startUrl: new URL(STRAVA_AUTH_START_PATH, publicUrl).toString(),
    isConnected: async () => (await auth.athleteId()) !== null,
  };

  if (env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    const summarizer = createActivitySummarizer({ claude, context, timeZone: env.TIMEZONE });
    const sync = createStravaActivitySync({
      client: createStravaClient({ auth }),
      activities,
      tokens,
      onNewActivity: async (activity) => notifier.notify(await summarizer.summarize(activity)),
      onDeauthorized: () => notifier.notify(stravaRevokedText()),
      logger,
    });
    registerStravaWebhook(app, {
      verifyToken: env.STRAVA_WEBHOOK_VERIFY_TOKEN,
      subscriptionId: env.STRAVA_SUBSCRIPTION_ID,
      athleteId: () => auth.athleteId(),
      onEvent: (event) =>
        tasks.run(`strava:${event.object_type}:${event.aspect_type}`, () => sync.handle(event)),
    });
    if (env.STRAVA_SUBSCRIPTION_ID === undefined) {
      logger.warn(
        { module: "strava" },
        "STRAVA_SUBSCRIPTION_ID unset: webhook events are rejected",
      );
    }
  }
} else {
  logger.info(
    { module: "strava" },
    "Strava disabled (client id/secret or TOKEN_ENCRYPTION_KEY unset)",
  );
}

const jobs: Job[] = [];
if (env.INTERVALS_API_KEY && env.INTERVALS_ATHLETE_ID) {
  const wellness = createWellnessSync({
    client: createIntervalsClient({
      apiKey: env.INTERVALS_API_KEY,
      athleteId: env.INTERVALS_ATHLETE_ID,
    }),
    health,
    timeZone: env.TIMEZONE,
    logger,
  });
  // ADR-015: hourly while awake, so the morning's sleep/HRV shows up soon after the watch syncs.
  jobs.push({
    name: "intervals-wellness",
    cron: "15 6-22 * * *",
    runOnStart: true,
    run: async () => {
      await wellness.syncRecent();
    },
  });
} else {
  logger.info({ module: "intervals" }, "Intervals.icu disabled (API key or athlete id unset)");
}

configureBot(bot, {
  authorizedChatId: env.TELEGRAM_AUTHORIZED_CHAT_ID,
  orchestrator: createOrchestrator({
    claude,
    conversations: createConversationStore(db),
    context,
  }),
  usage,
  activities,
  health,
  ...(stravaConnect ? { strava: stravaConnect } : {}),
  monthlyBudgetEur: env.MONTHLY_LLM_BUDGET_EUR,
  timeZone: env.TIMEZONE,
  logger,
});

let scheduler: Scheduler | undefined;

// Railway sends SIGTERM on every redeploy — let in-flight requests finish first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "shutting down");
    Promise.all([app.close(), bot.isRunning() ? bot.stop() : undefined, scheduler?.stop()])
      // Let an activity summary that's already running finish and send.
      .then(() => tasks.drain())
      .then(
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
  // After migrations: jobs write to the DB, and runOnStart jobs fire immediately.
  scheduler = startScheduler({
    jobs,
    timeZone: env.TIMEZONE,
    logger,
    onFailure: (name, error) => notifier.notify(jobFailureText(name, error)),
    onRecovered: (name) => notifier.notify(jobRecoveredText(name)),
  });
  logger.info({ transport: transport.mode, thinkingDisabled: env.DISABLE_THINKING }, "started");
} catch (error) {
  logger.fatal({ err: error }, "startup failed");
  process.exit(1);
}

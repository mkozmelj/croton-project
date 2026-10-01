import Anthropic from "@anthropic-ai/sdk";
import { Bot } from "grammy";
import { createActionExecutor } from "./agent/action-executor.js";
import { createActivitySummarizer } from "./agent/activity-summary.js";
import { createCalendarContext } from "./agent/calendar-context.js";
import { createClaude } from "./agent/claude.js";
import { createContextBuilder } from "./agent/context.js";
import { createFeedbackRequester } from "./agent/feedback-questions.js";
import { createFitnessService } from "./agent/fitness.js";
import { createMarkerProposer } from "./agent/marker-proposals.js";
import { createConversationMemory } from "./agent/memory.js";
import { createOrchestrator } from "./agent/orchestrator.js";
import { createPlanBooking } from "./agent/plan-booking.js";
import { createPlanLinker } from "./agent/plan-link.js";
import { createPlanner } from "./agent/planner.js";
import { createToolHandlers } from "./agent/tool-handlers.js";
import {
  type ConnectDeps,
  IMPORT_ACTIVITY_DAYS,
  IMPORT_WELLNESS_DAYS,
  type ImportSummary,
} from "./bot/commands.js";
import { feedbackKeyboard, feedbackText } from "./bot/feedback.js";
import {
  activityFailureText,
  activityText,
  backgroundFailureText,
  budgetAlertText,
  googleConnectedText,
  jobFailureText,
  jobRecoveredText,
  recapQuestionText,
  serverFailureText,
  stravaConnectedText,
  stravaRevokedText,
  tokenRefreshFailureText,
} from "./bot/formatting.js";
import { createNotifier } from "./bot/notifier.js";
import { type BotTransport, configureBot, startBot } from "./bot/setup.js";
import { registerTelegramWebhook } from "./bot/webhook.js";
import { env } from "./config/env.js";
import { createActivityStore } from "./db/activities.js";
import { createActivityFeedbackStore } from "./db/activity-feedback.js";
import { createAthleteProfileStore } from "./db/athlete-profile.js";
import { createDatabase, runMigrations } from "./db/client.js";
import { createConversationMemoryStore } from "./db/conversation-memories.js";
import { createConversationStore } from "./db/conversations.js";
import { createFitnessMarkerStore } from "./db/fitness-markers.js";
import { createGoalStore } from "./db/goals.js";
import { createHealthMetricsStore } from "./db/health-metrics.js";
import { createLiteratureStore } from "./db/literature.js";
import { createUsageStore } from "./db/llm-usage.js";
import { createOAuthStateStore } from "./db/oauth-states.js";
import { createOAuthTokenStore, type OAuthProvider } from "./db/oauth-tokens.js";
import { createPendingActionStore } from "./db/pending-actions.js";
import { createTrainingPlanStore } from "./db/training-plans.js";
import {
  GOOGLE_AUTH_CALLBACK_PATH,
  GOOGLE_AUTH_START_PATH,
  registerGoogleAuthRoutes,
} from "./integrations/google/auth-routes.js";
import { type CalendarClient, createCalendarClient } from "./integrations/google/calendar.js";
import { createGoogleAuth } from "./integrations/google/oauth.js";
import {
  createIntervalsClient,
  intervalsBasicCredentials,
} from "./integrations/intervals/client.js";
import { createProfileSync, type ProfileSync } from "./integrations/intervals/profile-sync.js";
import { createWellnessSync, type WellnessSync } from "./integrations/intervals/wellness-sync.js";
import { createTokenCipher } from "./integrations/oauth-crypto.js";
import { createStravaActivitySync } from "./integrations/strava/activity-sync.js";
import {
  registerStravaAuthRoutes,
  STRAVA_AUTH_CALLBACK_PATH,
  STRAVA_AUTH_START_PATH,
} from "./integrations/strava/auth-routes.js";
import { createStravaClient } from "./integrations/strava/client.js";
import {
  createStravaHistoryImport,
  type StravaHistoryImport,
} from "./integrations/strava/history-import.js";
import { createStravaAuth, StravaAuthError } from "./integrations/strava/oauth.js";
import { registerStravaWebhook } from "./integrations/strava/webhook.js";
import { isReportedRefreshFailure } from "./integrations/token-refresh.js";
import { createOpenAIEmbedder } from "./knowledge/embeddings.js";
import { createLiteratureSearch } from "./knowledge/literature-search.js";
import { connectionStringSecrets, createLogger } from "./logging/logger.js";
import { registerInfoPages } from "./pages.js";
import { type Job, type Scheduler, startScheduler } from "./scheduler/cron.js";
import { buildServer } from "./server.js";
import { createBackgroundTasks } from "./utils/background.js";
import { processErrorHandlers, withTimeout } from "./utils/process-guards.js";

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
      env.GOOGLE_CLIENT_SECRET,
      env.TOKEN_ENCRYPTION_KEY,
      env.INTERVALS_API_KEY,
      env.INTERVALS_API_KEY && intervalsBasicCredentials(env.INTERVALS_API_KEY),
      env.OPENAI_API_KEY,
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

// Stack doc §5: errors that escaped every handler still reach the athlete.
const guards = processErrorHandlers({
  logger,
  notify: notifier.notify,
  exit: (code) => process.exit(code),
});
process.on("unhandledRejection", (reason) => void guards.unhandledRejection(reason));
process.on("uncaughtException", (error) => void guards.uncaughtException(error));

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

const chatId = env.TELEGRAM_AUTHORIZED_CHAT_ID;
const activities = createActivityStore(db);
const activityFeedback = createActivityFeedbackStore(db);
const health = createHealthMetricsStore(db);
const profile = createAthleteProfileStore(db);
const markers = createFitnessMarkerStore(db);
const fitness = createFitnessService({ markers, profile });
const goals = createGoalStore(db);
const plans = createTrainingPlanStore(db);
const pending = createPendingActionStore(db);
const conversations = createConversationStore(db);
const memories = createConversationMemoryStore(db);
const context = createContextBuilder({
  profile,
  activities,
  health,
  fitness,
  goals,
  plans,
  pending,
  memories,
  feedback: activityFeedback,
  chatId,
  timeZone: env.TIMEZONE,
});
// ADR-014: without OPENAI_API_KEY the tool stays offered and answers "not configured".
const literature = createLiteratureSearch({
  store: createLiteratureStore(db),
  embedder: env.OPENAI_API_KEY
    ? createOpenAIEmbedder({ apiKey: env.OPENAI_API_KEY, usage, timeZone: env.TIMEZONE })
    : null,
  logger,
});
const tools = createToolHandlers({ pending, goals, plans, literature });
const tasks = createBackgroundTasks({
  logger,
  onError: async (label, error) => {
    // A failed token refresh already alerted once for its failure streak.
    if (isReportedRefreshFailure(error)) return;
    await notifier.notify(
      label.startsWith("strava") ? activityFailureText() : backgroundFailureText(label),
    );
  },
});

// Local dev has no APP_URL; Strava always accepts localhost as a callback domain.
const publicUrl = env.APP_URL ?? `http://localhost:${env.PORT}`;
const app = buildServer({
  logger,
  onServerError: (route) => notifier.notify(serverFailureText(route)),
});
registerInfoPages(app);
if (transport.mode === "webhook") {
  registerTelegramWebhook(app, { bot, secretToken: transport.secretToken });
}

const connect: Partial<Record<OAuthProvider, ConnectDeps>> = {};
const tokens = env.TOKEN_ENCRYPTION_KEY
  ? createOAuthTokenStore(db, createTokenCipher(env.TOKEN_ENCRYPTION_KEY))
  : undefined;
const states = createOAuthStateStore(db);

// Google Calendar (ADR-002: REST). Without it, confirmed plans are saved but not booked.
let calendarClient: CalendarClient | null = null;
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && tokens) {
  const googleAuth = createGoogleAuth({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL(GOOGLE_AUTH_CALLBACK_PATH, publicUrl).toString(),
    tokens,
    onRefreshFailed: (reason) =>
      notifier.notify(tokenRefreshFailureText("Google Calendar", reason)),
  });
  registerGoogleAuthRoutes(app, {
    auth: googleAuth,
    states,
    onConnected: () => notifier.notify(googleConnectedText()),
  });
  connect.google = {
    states,
    startUrl: new URL(GOOGLE_AUTH_START_PATH, publicUrl).toString(),
    isConnected: () => googleAuth.isConnected(),
  };
  calendarClient = createCalendarClient({ auth: googleAuth });
} else {
  logger.info(
    { module: "google" },
    "Google Calendar disabled (client id/secret or TOKEN_ENCRYPTION_KEY unset)",
  );
}
const calendar = async () =>
  calendarClient && (await connect.google?.isConnected()) ? calendarClient : null;

const jobs: Job[] = [];
let wellness: WellnessSync | undefined;
let profileSync: ProfileSync | undefined;
if (env.INTERVALS_API_KEY && env.INTERVALS_ATHLETE_ID) {
  const intervalsClient = createIntervalsClient({
    apiKey: env.INTERVALS_API_KEY,
    athleteId: env.INTERVALS_ATHLETE_ID,
  });
  const wellnessSync = createWellnessSync({
    client: intervalsClient,
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
      await wellnessSync.syncRecent();
    },
  });
  const intervalsProfile = createProfileSync({
    client: intervalsClient,
    markers,
    fitness,
    timeZone: env.TIMEZONE,
    logger,
  });
  // ADR-016: thresholds change rarely, and only plans use them: weekly, half an hour before
  // the Sunday recap, plus on boot (the planner also refreshes them before each plan).
  jobs.push({
    name: "intervals-profile",
    cron: "30 18 * * 0",
    runOnStart: true,
    run: async () => {
      await intervalsProfile.sync();
    },
  });
  wellness = wellnessSync;
  profileSync = intervalsProfile;
} else {
  logger.info({ module: "intervals" }, "Intervals.icu disabled (API key or athlete id unset)");
}

const planner = createPlanner({
  claude,
  context,
  conversations,
  pending,
  calendar: createCalendarContext({ calendar, timeZone: env.TIMEZONE, logger }),
  tools,
  ...(profileSync ? { refreshThresholds: profileSync.sync } : {}),
  chatId,
  timeZone: env.TIMEZONE,
  logger,
});
const feedbackRequests = createFeedbackRequester({
  plans,
  feedback: activityFeedback,
  timeZone: env.TIMEZONE,
});
const markerProposals = createMarkerProposer({
  plans,
  pending,
  fitness,
  chatId,
  timeZone: env.TIMEZONE,
});

let stravaImport: StravaHistoryImport | undefined;
if (env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && tokens) {
  const auth = createStravaAuth({
    clientId: env.STRAVA_CLIENT_ID,
    clientSecret: env.STRAVA_CLIENT_SECRET,
    redirectUri: new URL(STRAVA_AUTH_CALLBACK_PATH, publicUrl).toString(),
    tokens,
    onRefreshFailed: (reason) => notifier.notify(tokenRefreshFailureText("Strava", reason)),
  });
  registerStravaAuthRoutes(app, {
    auth,
    states,
    onConnected: () => notifier.notify(stravaConnectedText()),
  });
  connect.strava = {
    states,
    startUrl: new URL(STRAVA_AUTH_START_PATH, publicUrl).toString(),
    isConnected: async () => (await auth.athleteId()) !== null,
  };

  const stravaClient = createStravaClient({ auth });
  stravaImport = createStravaHistoryImport({ client: stravaClient, activities, logger });

  if (env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
    const summarizer = createActivitySummarizer({ claude, context, timeZone: env.TIMEZONE });
    const planLinker = createPlanLinker({
      plans,
      strava: stravaClient,
      canWrite: () => auth.canWriteActivities(),
      timeZone: env.TIMEZONE,
      logger,
    });
    const sync = createStravaActivitySync({
      client: stravaClient,
      activities,
      tokens,
      onNewActivity: async (activity) => {
        await notifier.notify(
          activityText(activity, env.TIMEZONE, await summarizer.summarize(activity)),
        );
        // ADR-016: a completed field test, or a workout that beat a threshold, proposes markers.
        const proposals = await markerProposals.propose(activity);
        for (const proposal of proposals) await notifier.propose(proposal);
        // ADR-018: last, so a failure here can't hold back the summary or the proposals.
        const questions = await feedbackRequests.prepare(activity, proposals.length > 0);
        if (questions.length > 0) {
          const known = await activityFeedback.get(activity.id);
          await notifier.notifyWithButtons(
            feedbackText(activity, questions, known, env.TIMEZONE),
            feedbackKeyboard(activity.id, questions, known),
          );
        }
        // After everything the athlete sees: a Strava API failure here is alerted by the
        // task runner and can't hold back the Telegram messages.
        await planLinker.link(activity);
      },
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

// The weekly recap: Sunday 19:00 local time, in the IANA zone (never a fixed "CET" offset).
jobs.push({
  name: "sunday-recap",
  cron: "0 19 * * 0",
  run: async () => {
    await notifier.notify(recapQuestionText((await planner.startRecap()).weekStart));
  },
});

// Turns older than 60 days become a memory note, monthly (1st, 03:30 local).
const conversationMemory = createConversationMemory({
  claude,
  conversations,
  memories,
  timeZone: env.TIMEZONE,
  logger,
});
jobs.push({
  name: "conversation-memory",
  cron: "30 3 1 * *",
  run: async () => {
    await conversationMemory.consolidate();
  },
});

// /import: one-time history (12 months of Strava activities, 90 days of wellness), safe to
// repeat. The two parts are independent: one failing doesn't stop the other.
const importHistory = async (): Promise<ImportSummary> => {
  const [stravaResult, wellnessResult] = await Promise.allSettled([
    stravaImport ? stravaImport.run(IMPORT_ACTIVITY_DAYS) : Promise.resolve(null),
    wellness ? wellness.backfill(IMPORT_WELLNESS_DAYS) : Promise.resolve(null),
  ]);
  for (const result of [stravaResult, wellnessResult]) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason }, "history import part failed");
    }
  }
  return {
    activities:
      stravaResult.status === "fulfilled"
        ? stravaResult.value
        : // Configured but not connected (or access revoked): same as not configured.
          stravaResult.reason instanceof StravaAuthError
          ? null
          : "failed",
    wellnessDays:
      wellnessResult.status === "fulfilled" ? (wellnessResult.value?.length ?? null) : "failed",
  };
};

const orchestrator = createOrchestrator({
  claude,
  conversations,
  context,
  tools,
  pending,
  planner,
  feedback: activityFeedback,
  chatId,
  timeZone: env.TIMEZONE,
  logger,
});

configureBot(bot, {
  authorizedChatId: chatId,
  orchestrator,
  executor: createActionExecutor({
    pending,
    goals,
    profile,
    fitness,
    booking: createPlanBooking({ plans, calendar, timeZone: env.TIMEZONE }),
    timeZone: env.TIMEZONE,
  }),
  usage,
  activities,
  health,
  profile,
  fitness,
  goals,
  plans,
  pending,
  planner,
  onboarding: orchestrator,
  activityFeedback: {
    feedback: activityFeedback,
    activities,
    pending,
    timeZone: env.TIMEZONE,
  },
  importHistory,
  // /selftest: a background task that fails on purpose, to check the alert path end to end.
  runSelfTest: () =>
    tasks.run("selftest", async () => {
      throw new Error("self-test: deliberate failure in a background task");
    }),
  connect,
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
  // Not fatal: search retries the load on its first call.
  await literature.load().catch((error: unknown) => {
    logger.error({ err: error, module: "literature" }, "literature index load failed");
  });
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
  await withTimeout(notifier.notify("⚠️ The app failed to start after a deploy. It's logged."));
  process.exit(1);
}

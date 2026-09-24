import type { Bot } from "grammy";
import { totalsBySport } from "../agent/activity-format.js";
import { BudgetExceededError, budgetLevel } from "../agent/budget.js";
import type { FitnessService } from "../agent/fitness.js";
import type { Orchestrator } from "../agent/orchestrator.js";
import type { Planner } from "../agent/planner.js";
import { loadSeason } from "../agent/season.js";
import type { ActivityStore } from "../db/activities.js";
import type { AthleteProfileStore } from "../db/athlete-profile.js";
import type { GoalStore } from "../db/goals.js";
import type { HealthMetricsStore } from "../db/health-metrics.js";
import type { UsageStore } from "../db/llm-usage.js";
import type { OAuthStateStore } from "../db/oauth-states.js";
import type { OAuthProvider } from "../db/oauth-tokens.js";
import type { PendingActionStore } from "../db/pending-actions.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import { parseBackground } from "../training/background.js";
import { addDays, localDate, localMidnight, monthStart, weekStart } from "../utils/dates.js";
import {
  budgetRefusalText,
  budgetText,
  connectText,
  goalsText,
  onboardingIntroText,
  planCommandText,
  profileText,
  startText,
  statusText,
  tomorrowText,
} from "./formatting.js";
import { replyWithProposals, withTyping } from "./handlers.js";

export const COMMANDS = [
  { command: "recap", description: "Weekly recap and next week's plan" },
  { command: "plan", description: "This week's plan" },
  { command: "tomorrow", description: "Tomorrow's sessions" },
  { command: "goals", description: "Season goals and weeks to go" },
  { command: "profile", description: "Fitness markers, zones, background" },
  { command: "onboard", description: "Tell me about your training background" },
  { command: "status", description: "This week's training, recovery and budget" },
  { command: "connect", description: "Link Strava or Google Calendar" },
  { command: "budget", description: "LLM spend this month" },
  { command: "start", description: "Welcome and setup info" },
] as const;

// One per configured OAuth provider (client id/secret + encryption key present).
export type ConnectDeps = {
  states: Pick<OAuthStateStore, "create">;
  // Absolute URL of /auth/<provider>/start, without the state.
  startUrl: string;
  isConnected: () => Promise<boolean>;
};

export type CommandDeps = {
  usage: Pick<UsageStore, "spendByModelSince" | "spendSince">;
  activities: Pick<ActivityStore, "between">;
  health: Pick<HealthMetricsStore, "since">;
  profile: Pick<AthleteProfileStore, "get">;
  fitness: Pick<FitnessService, "latest">;
  goals: Pick<GoalStore, "activeInSeasons">;
  plans: Pick<TrainingPlanStore, "forWeek">;
  pending: Pick<PendingActionStore, "live">;
  planner: Pick<Planner, "startRecap" | "generate">;
  onboarding: Pick<Orchestrator, "startOnboarding">;
  connect: Partial<Record<OAuthProvider, ConnectDeps>>;
  monthlyBudgetEur: number;
  timeZone: string;
  now?: () => Date;
};

const PROVIDER_NAMES: Record<OAuthProvider, "Strava" | "Google Calendar"> = {
  strava: "Strava",
  google: "Google Calendar",
};

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const now = deps.now ?? (() => new Date());
  const today = () => localDate(now(), deps.timeZone);

  bot.command("start", async (ctx) => {
    const profile = await deps.profile.get();
    await ctx.reply(startText(ctx.chat.id, !parseBackground(profile?.background)));
  });

  bot.command("budget", async (ctx) => {
    const instant = now();
    const byModel = await deps.usage.spendByModelSince(
      monthStart(localDate(instant, deps.timeZone)),
    );
    const spendEur = byModel.reduce((sum, row) => sum + row.costEur, 0);
    const monthLabel = new Intl.DateTimeFormat("en-GB", {
      timeZone: deps.timeZone,
      month: "long",
      year: "numeric",
    }).format(instant);

    await ctx.reply(
      budgetText({
        monthLabel,
        spendEur,
        capEur: deps.monthlyBudgetEur,
        level: budgetLevel(spendEur, deps.monthlyBudgetEur),
        byModel,
      }),
    );
  });

  bot.command("status", async (ctx) => {
    const instant = now();
    const day = localDate(instant, deps.timeZone);
    const start = weekStart(day);
    const [week, recentHealth, spendEur, stravaConnected, season] = await Promise.all([
      deps.activities.between(localMidnight(start, deps.timeZone), instant),
      deps.health.since(addDays(day, -2)),
      deps.usage.spendSince(monthStart(day)),
      deps.connect.strava?.isConnected() ?? Promise.resolve(false),
      loadSeason(deps.goals, day),
    ]);
    await ctx.reply(
      statusText({
        phase: season.aGoal
          ? `${season.phase ?? "unknown"} (A goal: ${season.aGoal.event.name}, ${season.aGoal.event.date})`
          : "unknown, no A goal set (/goals)",
        weekStart: start,
        weekTotals: totalsBySport(week),
        lastActivity: week.at(-1) ?? null,
        latestHealth: recentHealth[0] ?? null,
        stravaConnected,
        spendEur,
        capEur: deps.monthlyBudgetEur,
        level: budgetLevel(spendEur, deps.monthlyBudgetEur),
        timeZone: deps.timeZone,
      }),
    );
  });

  // `/connect` lists every configured provider; `/connect calendar` or `/connect strava` one.
  bot.command("connect", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const wanted: OAuthProvider[] =
      arg === "calendar" || arg === "google"
        ? ["google"]
        : arg === "strava"
          ? ["strava"]
          : ["strava", "google"];
    const available = wanted.filter((provider) => deps.connect[provider]);
    if (available.length === 0) {
      await ctx.reply(
        `${wanted.map((p) => PROVIDER_NAMES[p]).join(" and ")} isn't configured on the server yet (missing client id/secret or encryption key).`,
      );
      return;
    }
    for (const provider of available) {
      const connect = deps.connect[provider];
      if (!connect) continue;
      // ADR-011: a fresh single-use state per link.
      const state = await connect.states.create(provider);
      const url = new URL(connect.startUrl);
      url.searchParams.set("state", state);
      await ctx.reply(connectText(PROVIDER_NAMES[provider], url.toString()), {
        link_preview_options: { is_disabled: true },
      });
    }
  });

  // `/recap` asks for the week's feedback first; `/recap <feedback>` plans right away.
  bot.command("recap", async (ctx) => {
    const feedback = ctx.match.trim();
    if (!feedback) {
      await ctx.reply(await deps.planner.startRecap());
      return;
    }
    try {
      await replyWithProposals(
        ctx,
        await withTyping(ctx, () => deps.planner.generate({ feedback })),
      );
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      await ctx.reply(budgetRefusalText());
    }
  });

  bot.command("plan", async (ctx) => {
    const [stored, pending] = await Promise.all([
      deps.plans.forWeek(weekStart(today())),
      deps.pending.live(ctx.chat.id, ["apply_plan"]),
    ]);
    await ctx.reply(planCommandText(stored?.plan ?? null, pending.length > 0));
  });

  bot.command("tomorrow", async (ctx) => {
    const tomorrow = addDays(today(), 1);
    const stored = await deps.plans.forWeek(weekStart(tomorrow));
    await ctx.reply(tomorrowText(stored?.plan ?? null, tomorrow));
  });

  bot.command("goals", async (ctx) => {
    const day = today();
    await ctx.reply(goalsText(await loadSeason(deps.goals, day), day));
  });

  bot.command("profile", async (ctx) => {
    const instant = now();
    const day = localDate(instant, deps.timeZone);
    const [profile, markers, season, recent] = await Promise.all([
      deps.profile.get(),
      deps.fitness.latest(),
      loadSeason(deps.goals, day),
      deps.activities.between(localMidnight(addDays(day, -42), deps.timeZone), instant),
    ]);
    await ctx.reply(
      profileText({
        profile,
        markers,
        recentSports: recent.map((a) => a.sport),
        season,
        today: day,
      }),
    );
  });

  bot.command("onboard", async (ctx) => {
    await deps.onboarding.startOnboarding();
    await ctx.reply(onboardingIntroText());
  });
}

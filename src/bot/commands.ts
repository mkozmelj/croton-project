import type { Bot } from "grammy";
import { totalsBySport } from "../agent/activity-format.js";
import { budgetLevel } from "../agent/budget.js";
import type { ActivityStore } from "../db/activities.js";
import type { HealthMetricsStore } from "../db/health-metrics.js";
import type { UsageStore } from "../db/llm-usage.js";
import type { OAuthStateStore } from "../db/oauth-states.js";
import { addDays, localDate, localMidnight, monthStart, weekStart } from "../utils/dates.js";
import { budgetText, connectText, startText, statusText } from "./formatting.js";

export const COMMANDS = [
  { command: "status", description: "This week's training, recovery and budget" },
  { command: "connect", description: "Link your Strava account" },
  { command: "budget", description: "LLM spend this month" },
  { command: "start", description: "Welcome and setup info" },
] as const;

// Present only when Strava is configured (client id/secret + encryption key).
export type StravaConnectDeps = {
  states: Pick<OAuthStateStore, "create">;
  // Absolute URL of /auth/strava/start, without the state.
  startUrl: string;
  isConnected: () => Promise<boolean>;
};

export type CommandDeps = {
  usage: Pick<UsageStore, "spendByModelSince" | "spendSince">;
  activities: Pick<ActivityStore, "between">;
  health: Pick<HealthMetricsStore, "since">;
  strava?: StravaConnectDeps;
  monthlyBudgetEur: number;
  timeZone: string;
  now?: () => Date;
};

export function registerCommands(bot: Bot, deps: CommandDeps): void {
  const now = deps.now ?? (() => new Date());

  bot.command("start", async (ctx) => {
    await ctx.reply(startText(ctx.chat.id));
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
    const today = localDate(instant, deps.timeZone);
    const start = weekStart(today);
    const [week, recentHealth, spendEur, stravaConnected] = await Promise.all([
      deps.activities.between(localMidnight(start, deps.timeZone), instant),
      deps.health.since(addDays(today, -2)),
      deps.usage.spendSince(monthStart(today)),
      deps.strava?.isConnected() ?? Promise.resolve(false),
    ]);
    await ctx.reply(
      statusText({
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

  bot.command("connect", async (ctx) => {
    if (!deps.strava) {
      await ctx.reply(
        "Strava isn't configured on the server yet (missing Strava/encryption env vars).",
      );
      return;
    }
    // ADR-011: a fresh single-use state per link.
    const state = await deps.strava.states.create("strava");
    const url = new URL(deps.strava.startUrl);
    url.searchParams.set("state", state);
    await ctx.reply(connectText(url.toString()), { link_preview_options: { is_disabled: true } });
  });
}

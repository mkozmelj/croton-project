import type { Bot } from "grammy";
import { budgetLevel } from "../agent/budget.js";
import type { UsageStore } from "../db/llm-usage.js";
import { localDate, monthStart } from "../utils/dates.js";
import { budgetText, startText } from "./formatting.js";

export const COMMANDS = [
  { command: "start", description: "Welcome and setup info" },
  { command: "budget", description: "LLM spend this month" },
] as const;

type CommandDeps = {
  usage: Pick<UsageStore, "spendByModelSince">;
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
}

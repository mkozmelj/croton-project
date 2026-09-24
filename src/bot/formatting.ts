import type { BudgetLevel } from "../agent/budget.js";
import type { ModelSpend } from "../db/llm-usage.js";

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// Splits on paragraph, then line, then word boundaries so no chunk exceeds `limit`.
export function splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

const eur = (value: number) => `€${value.toFixed(2)}`;

const LEVEL_DESCRIPTIONS: Record<BudgetLevel, string> = {
  normal: "normal",
  warning: "normal (75% alert sent)",
  haiku_only: "Haiku only",
  minimal: "minimal (no LLM replies)",
  stopped: "stopped (no LLM replies)",
};

export function startText(chatId: number): string {
  return [
    "Hi, I'm your training coach.",
    "",
    "Right now I can chat about training: plans, workouts, pacing, recovery. Strava, calendar and health data come in later phases.",
    "",
    "Commands:",
    "/budget - LLM spend this month",
    "",
    `This chat's ID is ${chatId}.`,
  ].join("\n");
}

type BudgetSummary = {
  monthLabel: string;
  spendEur: number;
  capEur: number;
  level: BudgetLevel;
  byModel: ModelSpend[];
};

export function budgetText({
  monthLabel,
  spendEur,
  capEur,
  level,
  byModel,
}: BudgetSummary): string {
  const percent = capEur > 0 ? Math.round((spendEur / capEur) * 100) : 0;
  const lines = [
    `LLM spend, ${monthLabel}`,
    `${eur(spendEur)} of ${eur(capEur)} (${percent}%)`,
    `Mode: ${LEVEL_DESCRIPTIONS[level]}`,
  ];
  if (byModel.length > 0) {
    lines.push("", "By model:");
    for (const row of byModel) {
      const cached = row.cacheReadInputTokens.toLocaleString("en-US");
      lines.push(
        `- ${row.model}: ${row.calls} calls, ${eur(row.costEur)}, ${cached} cached tokens read`,
      );
    }
  }
  return lines.join("\n");
}

export function budgetAlertText(level: BudgetLevel, spendEur: number, capEur: number): string {
  const spent = `${eur(spendEur)} of ${eur(capEur)}`;
  switch (level) {
    case "warning":
      return `Budget alert: 75% of this month's LLM budget used (${spent}).`;
    case "haiku_only":
      return `Budget alert: 90% used (${spent}). Switching every call to Haiku until the 1st.`;
    case "minimal":
      return `Budget nearly exhausted (${spent}). LLM replies are paused. Full service resumes on the 1st.`;
    case "stopped":
      return `Monthly LLM budget used up (${spent}). LLM replies are off until the 1st.`;
    case "normal":
      return `Budget back to normal (${spent}).`;
  }
}

export function budgetRefusalText(): string {
  return "This month's LLM budget is (nearly) used up, so I can't reply with the model right now. Full service resumes on the 1st. /budget shows the numbers.";
}

export function failureText(): string {
  return "Something broke while handling that message. It's logged; try again in a bit.";
}

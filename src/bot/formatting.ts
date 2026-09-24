import {
  describeHealth,
  describeTotals,
  formatDayTime,
  type SportTotals,
} from "../agent/activity-format.js";
import type { BudgetLevel } from "../agent/budget.js";
import type { ActivitySummary } from "../db/activities.js";
import type { HealthMetrics } from "../db/health-metrics.js";
import type { ModelSpend } from "../db/llm-usage.js";
import { IntervalsApiError } from "../integrations/intervals/client.js";

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
    "I can chat about training: plans, workouts, pacing, recovery. I see your Strava activities and your Garmin recovery data (via Intervals.icu) once they're connected. Calendar and weekly plans come in a later phase.",
    "",
    "Commands:",
    "/status - this week's training, recovery and budget",
    "/connect - link your Strava account",
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

type StatusSummary = {
  weekStart: string;
  weekTotals: SportTotals[];
  lastActivity: ActivitySummary | null;
  latestHealth: HealthMetrics | null;
  stravaConnected: boolean;
  spendEur: number;
  capEur: number;
  level: BudgetLevel;
  timeZone: string;
};

export function statusText(status: StatusSummary): string {
  const lines = [
    "Phase: not set yet (goals and periodization come with the planning phase)",
    "",
    `This week (since Mon ${status.weekStart}):`,
    ...(status.weekTotals.length > 0
      ? status.weekTotals.map((totals) => `- ${describeTotals(totals)}`)
      : ["- nothing logged yet"]),
  ];
  if (status.lastActivity) {
    lines.push(
      `Last activity: ${formatDayTime(status.lastActivity.startedAt, status.timeZone)}, ${status.lastActivity.name ?? status.lastActivity.sport}`,
    );
  }
  lines.push(
    "",
    status.latestHealth
      ? `Recovery (${status.latestHealth.date}): ${describeHealth(status.latestHealth)}`
      : "Recovery: no health data yet",
    "",
    `Strava: ${status.stravaConnected ? "connected" : "not connected (/connect)"}`,
    `Budget: ${eur(status.capEur - status.spendEur)} left of ${eur(status.capEur)}, mode ${LEVEL_DESCRIPTIONS[status.level]}`,
  );
  return lines.join("\n");
}

export function connectText(url: string): string {
  return `Open this link to connect Strava (valid for 10 minutes, works once):\n${url}`;
}

export function stravaConnectedText(): string {
  return "Strava connected. New activities will show up here with a short summary.";
}

export function stravaRevokedText(): string {
  return "Strava access was revoked, so I no longer get your activities. Send /connect to link it again.";
}

export function activityFailureText(): string {
  return "Something broke while processing a Strava activity. It's logged; I'll look into it.";
}

export function serverFailureText(route: string): string {
  const what = route.startsWith("/webhook/strava")
    ? "receiving a Strava update"
    : route.startsWith("/auth/")
      ? "connecting an account"
      : `handling ${route}`;
  return `Something broke while ${what}. It's logged; I'll look into it.`;
}

const JOB_DESCRIPTIONS: Record<string, string> = {
  "intervals-wellness": "Fetching health data from Intervals.icu",
};

export function jobFailureText(jobName: string, error: unknown): string {
  const what = JOB_DESCRIPTIONS[jobName] ?? `The ${jobName} job`;
  const hint =
    error instanceof IntervalsApiError && (error.status === 401 || error.status === 403)
      ? " The API key was rejected; check INTERVALS_API_KEY."
      : "";
  return `${what} failed.${hint} It's logged; I'll retry every hour and tell you when it works again.`;
}

export function jobRecoveredText(jobName: string): string {
  const what = JOB_DESCRIPTIONS[jobName] ?? `The ${jobName} job`;
  return `${what} works again.`;
}

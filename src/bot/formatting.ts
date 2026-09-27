import {
  describeHealth,
  describeTotals,
  formatDayTime,
  type SportTotals,
} from "../agent/activity-format.js";
import type { BudgetLevel } from "../agent/budget.js";
import { planText, workoutDetail } from "../agent/plan-format.js";
import type { SeasonView } from "../agent/season.js";
import type { ActivitySummary } from "../db/activities.js";
import type { AthleteProfile } from "../db/athlete-profile.js";
import type { StoredMarker } from "../db/fitness-markers.js";
import type { GoalWithEvent } from "../db/goals.js";
import type { HealthMetrics } from "../db/health-metrics.js";
import type { ModelSpend } from "../db/llm-usage.js";
import { IntervalsApiError } from "../integrations/intervals/client.js";
import type { RefreshFailureReason } from "../integrations/token-refresh.js";
import { parseBackground } from "../training/background.js";
import {
  type BodyReading,
  bodyChange,
  describeBodyChange,
  describeBodyWeek,
  latestWeight,
  wattsPerKg,
  weeklyBody,
} from "../training/body.js";
import {
  describeAge,
  describeSource,
  formatMarkerValue,
  isStale,
  missingAnchors,
} from "../training/markers.js";
import { weeksAndDaysUntil } from "../training/phase.js";
import { sortedWorkouts, type WeekPlan } from "../training/plan.js";
import { describeZones } from "../training/zones.js";
import type { ImportSummary } from "./commands.js";

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

export function startText(chatId: number, offerOnboarding: boolean): string {
  const lines = [
    "Hi, I'm your training coach.",
    "",
    "I plan your training week by week, adjust it when life happens, and put it in your Google Calendar once you confirm. I see your Strava activities, your Garmin recovery data and thresholds (via Intervals.icu), and the goals you set with me.",
    "",
    "Commands:",
    "/recap - weekly recap and next week's plan (also every Sunday at 19:00)",
    "/plan - this week's plan",
    "/tomorrow - tomorrow's sessions",
    "/goals - season goals and weeks to go",
    "/profile - fitness markers, zones and background",
    "/onboard - tell me about your training background",
    "/status - this week's training, recovery and budget",
    "/import - load 12 months of Strava history (once, after connecting)",
    "/connect - link Strava or Google Calendar",
    "/reauth - reconnect Strava or Google Calendar when access has expired",
    "/budget - LLM spend this month",
    "/deep <question> - answer with the stronger model",
  ];
  if (offerOnboarding) {
    lines.push(
      "",
      "I don't know your training background yet. Send /onboard and I'll ask a few questions (years per sport, recent races, availability, injuries), so the first plan starts at the right level.",
    );
  }
  lines.push("", `This chat's ID is ${chatId}.`);
  return lines.join("\n");
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
  phase: string;
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
    `Phase: ${status.phase}`,
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

export function connectText(provider: "Strava" | "Google Calendar", url: string): string {
  return `Open this link to connect ${provider} (valid for 10 minutes, works once):\n${url}`;
}

export function googleConnectedText(): string {
  return "Google Calendar connected. Confirmed plans will be booked into it.";
}

export function stravaConnectedText(): string {
  return "Strava connected. New activities will show up here with a short summary.";
}

export function stravaRevokedText(): string {
  return "Strava access was revoked, so I no longer get your activities. Send /reauth strava to link it again.";
}

// A token refresh finally failed (ADR-011, token-refresh.ts). Sent once per failure streak.
export function tokenRefreshFailureText(
  provider: "Strava" | "Google Calendar",
  reason: RefreshFailureReason,
): string {
  const command = provider === "Strava" ? "/reauth strava" : "/reauth calendar";
  const what =
    provider === "Strava" ? "read your activities" : "read your calendar or book sessions";
  if (reason === "rejected") {
    return `${provider} rejected the access renewal (access revoked or expired), so I can't ${what}. Send ${command} to connect it again.`;
  }
  return `I couldn't renew ${provider} access: 3 attempts failed (${provider} didn't answer properly). It's logged, and I'll try again next time it's needed. If this keeps coming back, send ${command}.`;
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
  "intervals-profile": "Fetching thresholds and zones from Intervals.icu",
  "sunday-recap": "Starting the Sunday recap",
  "conversation-memory": "Summarizing old conversations",
};

export function jobFailureText(jobName: string, error: unknown): string {
  const what = JOB_DESCRIPTIONS[jobName] ?? `The ${jobName} job`;
  const hint =
    error instanceof IntervalsApiError && (error.status === 401 || error.status === 403)
      ? " The API key was rejected; check INTERVALS_API_KEY."
      : "";
  return `${what} failed.${hint} It's logged; I'll retry on the next run and tell you when it works again.`;
}

export function jobRecoveredText(jobName: string): string {
  const what = JOB_DESCRIPTIONS[jobName] ?? `The ${jobName} job`;
  return `${what} works again.`;
}

export function onboardingIntroText(): string {
  return [
    "Let's set up your profile so plans start at the right level. A few questions, answer in your own words (you can skip any):",
    "",
    "1. How many years have you trained per sport (run, bike, swim, others), and how many hours does a typical week have?",
    "2. Any races in the last ~18 months? Date, event, distance and time.",
    "",
    "Availability, injuries and thresholds come next. I'll show you everything to confirm before saving.",
  ].join("\n");
}

export function goalsText(season: SeasonView, today: string): string {
  if (season.upcoming.length === 0) {
    return 'No active goals. Tell me your target race, e.g. "my main goal for 2027 is sub-4:45 at 70.3 Pula on 2027-09-26".';
  }
  const line = (goal: GoalWithEvent) => {
    const { weeks, days } = weeksAndDaysUntil(goal.event.date, today);
    const what = [goal.event.sport, goal.event.distance].filter(Boolean).join(", ");
    const target = goal.target ? `, ${goal.goalType} ${goal.target}` : `, ${goal.goalType}`;
    return `${goal.priority}  ${goal.event.name} (${what}) on ${goal.event.date}: ${weeks} weeks to go (${days} days)${target}`;
  };
  const lines = ["Season goals:", ...season.upcoming.map((goal) => `- ${line(goal)}`)];
  lines.push("", `Phase: ${season.phase ?? "unknown (no A goal)"}`);
  return lines.join("\n");
}

type ProfileSummary = {
  profile: AthleteProfile | null;
  markers: readonly StoredMarker[];
  // Weight/body-fat readings, 8 weeks back from this week's Monday (`bodyFrom`).
  body: readonly BodyReading[];
  bodyFrom: string;
  recentSports: readonly string[];
  season: SeasonView;
  today: string;
};

export function profileText({
  profile,
  markers,
  body,
  bodyFrom,
  recentSports,
  season,
  today,
}: ProfileSummary): string {
  const lines = ["Fitness markers:"];
  if (markers.length === 0) lines.push("- none yet");
  for (const m of markers) {
    const stale = isStale(m.measuredOn, today, season.phase) ? " - STALE, test due" : "";
    lines.push(
      `- ${m.sport}: ${formatMarkerValue(m.metric, m.value)} (${describeSource(m.source)}, ${m.measuredOn}, ${describeAge(m.measuredOn, today)})${stale}`,
    );
  }
  for (const missing of missingAnchors(markers, recentSports)) {
    lines.push(
      `- ${missing.sport}: no threshold yet, I'll plan by RPE and schedule ${missing.fieldTest}`,
    );
  }

  const ftp = markers.find((m) => m.sport === "bike" && m.metric === "ftp_w");
  const weight = latestWeight(body, today);
  if (ftp && weight) {
    lines.push(
      `- bike: ${wattsPerKg(ftp.value, weight.weightKg).toFixed(2)} W/kg (weight ${weight.weightKg.toFixed(1)} kg on ${weight.date})`,
    );
  }

  const weeks = weeklyBody(body, bodyFrom, 8);
  const change = bodyChange(weeks);
  lines.push("", "Body composition (weekly averages):");
  if (weeks.length === 0) lines.push("- no readings yet");
  for (const week of weeks.slice(-4)) lines.push(`- ${describeBodyWeek(week)}`);
  if (change) lines.push(`- ${describeBodyChange(change)}`);

  const zones = describeZones(profile?.sportZones);
  lines.push("", "Zones:", ...(zones.length > 0 ? zones.map((z) => `- ${z}`) : ["- none yet"]));

  const background = parseBackground(profile?.background);
  lines.push("", "Background:");
  if (!background) {
    lines.push("- not collected yet (/onboard)");
  } else {
    if (background.years_by_sport.length > 0) {
      lines.push(
        `- Years: ${background.years_by_sport.map((y) => `${y.sport} ${y.years}`).join(", ")}`,
      );
    }
    if (background.typical_weekly_hours != null) {
      lines.push(`- Typical week: ${background.typical_weekly_hours} h`);
    }
    for (const r of background.recent_results) lines.push(`- ${r.date}: ${r.event}`);
    if (background.notes) lines.push(`- ${background.notes}`);
  }
  const availability = profile?.preferences?.availability;
  if (typeof availability === "string") lines.push(`- Availability: ${availability}`);
  if (profile?.injuryNotes) lines.push(`- Injuries: ${profile.injuryNotes}`);
  lines.push("", "To change something: /profile help, or just tell me in chat.");
  return lines.join("\n");
}

export function profileEditHelpText(): string {
  return [
    "Edit your profile (you confirm each change with a button):",
    "/profile ftp 250",
    "/profile lthr run 168  (or bike, swim)",
    "/profile maxhr 190  (or /profile maxhr run 192)",
    "/profile pace 4:15  (run threshold pace per km)",
    "/profile css 1:45  (swim, per 100 m)",
    "/profile vdot 48.5, or from a race: /profile vdot 10k 45:30",
    "/profile availability Mon rest, Tue/Thu 6:30-7:45, long ride Sat",
    "/profile injuries none",
    "/profile name Alex",
    "",
    "Add a date to a threshold when it wasn't today: /profile ftp 250 2026-09-20. Zones follow the thresholds automatically. Goals are set in chat.",
  ].join("\n");
}

export function planCommandText(plan: WeekPlan | null, pendingPlan: boolean): string {
  const pending = pendingPlan ? "\n\nA plan proposal is waiting for your confirmation above." : "";
  if (!plan) return `No confirmed plan for this week. Send /recap to make one.${pending}`;
  return `${planText(plan)}${pending}`;
}

export function tomorrowText(plan: WeekPlan | null, tomorrow: string): string {
  const sessions = sortedWorkouts(plan?.workouts ?? []).filter((w) => w.date === tomorrow);
  if (!plan) return `No confirmed plan covers tomorrow (${tomorrow}). Send /recap to make one.`;
  if (sessions.length === 0) return `Tomorrow (${tomorrow}) is a rest day.`;
  return sessions.map(workoutDetail).join("\n\n");
}

export function importText(summary: ImportSummary): string {
  const lines = ["History import:"];
  const { activities, wellnessDays } = summary;
  if (activities === null) lines.push("- Strava: not connected (/connect strava)");
  else if (activities === "failed")
    lines.push("- Strava: failed, it's logged. Try /import again later.");
  else {
    lines.push(
      `- Strava: ${activities.fetched} activities from the last 12 months, ${activities.inserted} new`,
    );
  }
  if (wellnessDays === null) lines.push("- Intervals.icu: not configured");
  else if (wellnessDays === "failed")
    lines.push("- Intervals.icu: failed, it's logged. Try /import again later.");
  else lines.push(`- Intervals.icu: ${wellnessDays} days of wellness data (last 90 days)`);
  lines.push("", "Running it again only fills gaps; nothing is duplicated.");
  return lines.join("\n");
}

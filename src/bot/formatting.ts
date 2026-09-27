import {
  formatDayTime,
  formatDuration,
  formatKm,
  formatPace,
  healthParts,
  type SportTotals,
} from "../agent/activity-format.js";
import type { BudgetLevel } from "../agent/budget.js";
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
import { listZoneSets, zoneSetParts } from "../training/zones.js";
import type { ImportSummary } from "./commands.js";
import { bold, code, esc, italic, link, progressBar, quote, section, sportEmoji } from "./html.js";
import { markdownToHtml } from "./markdown.js";
import { planHtml, workoutHtml } from "./plan-html.js";

// Every message the bot writes itself, as Telegram HTML (ADR-017). Data from the DB, the
// athlete or the model is escaped; model prose goes through markdownToHtml().

const eur = (value: number) => `€${value.toFixed(2)}`;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const LEVEL_DESCRIPTIONS: Record<BudgetLevel, string> = {
  normal: "normal",
  warning: "normal (75% alert sent)",
  haiku_only: "Haiku only",
  minimal: "minimal (no LLM replies)",
  stopped: "stopped (no LLM replies)",
};

const command = (name: string, description: string) => `/${name} – ${esc(description)}`;

export function startText(chatId: number, offerOnboarding: boolean): string {
  const blocks = [
    "👋 <b>Hi, I'm your training coach.</b>",
    "I plan your training week by week, adjust it when life happens, and put it in your Google Calendar once you confirm. I see your Strava activities, your Garmin recovery data and thresholds (via Intervals.icu), and the goals you set with me.",
    section("📅 Training", [
      command("recap", "weekly recap and next week's plan (also Sundays at 19:00)"),
      command("plan", "this week's plan"),
      command("tomorrow", "tomorrow's sessions"),
      command("goals", "season goals and weeks to go"),
    ]),
    section("👤 You", [
      command("profile", "fitness markers, zones and background"),
      command("onboard", "tell me about your training background"),
      command("status", "this week's training, recovery and budget"),
    ]),
    section("🔗 Setup", [
      command("connect", "link Strava or Google Calendar"),
      command("reauth", "reconnect when access has expired"),
      command("import", "load 12 months of Strava history (once, after connecting)"),
    ]),
    section("💬 More", [
      command("budget", "LLM spend this month"),
      `/deep ${esc("<question>")} – answer with the stronger model`,
    ]),
  ];
  if (offerOnboarding) {
    blocks.push(
      "💡 I don't know your training background yet. Send /onboard and I'll ask a few questions (years per sport, recent races, availability, injuries), so the first plan starts at the right level.",
    );
  }
  blocks.push(`<i>This chat's ID is</i> ${code(String(chatId))}`);
  return blocks.join("\n\n");
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
  const share = capEur > 0 ? spendEur / capEur : 0;
  const blocks = [
    [
      `💶 <b>LLM spend · ${esc(monthLabel)}</b>`,
      `${progressBar(share)} ${Math.round(share * 100)}%`,
      `${eur(spendEur)} of ${eur(capEur)}`,
      `Mode: ${LEVEL_DESCRIPTIONS[level]}`,
    ].join("\n"),
  ];
  if (byModel.length > 0) {
    blocks.push(
      section(
        "By model",
        byModel.map((row) => {
          const cached = row.cacheReadInputTokens.toLocaleString("en-US");
          return `• ${code(row.model)}: ${row.calls} calls · ${eur(row.costEur)} · ${cached} cached tokens read`;
        }),
      ),
    );
  }
  return blocks.join("\n\n");
}

export function budgetAlertText(level: BudgetLevel, spendEur: number, capEur: number): string {
  const spent = `${eur(spendEur)} of ${eur(capEur)}`;
  switch (level) {
    case "warning":
      return `⚠️ <b>Budget alert:</b> 75% of this month's LLM budget used (${spent}).`;
    case "haiku_only":
      return `🟠 <b>Budget alert:</b> 90% used (${spent}). Switching every call to Haiku until the 1st.`;
    case "minimal":
      return `🛑 <b>Budget nearly exhausted</b> (${spent}). LLM replies are paused. Full service resumes on the 1st.`;
    case "stopped":
      return `🛑 <b>Monthly LLM budget used up</b> (${spent}). LLM replies are off until the 1st.`;
    case "normal":
      return `✅ Budget back to normal (${spent}).`;
  }
}

export function budgetRefusalText(): string {
  return "🛑 This month's LLM budget is (nearly) used up, so I can't reply with the model right now. Full service resumes on the 1st. /budget shows the numbers.";
}

export function failureText(): string {
  return "⚠️ Something broke while handling that message. It's logged; try again in a bit.";
}

// A reply the model wrote (chat, recap), converted from its Markdown.
export function modelText(markdown: string): string {
  return markdownToHtml(markdown);
}

// Header of an activity notification: the numbers, rendered by code.
function activityHeader(activity: ActivitySummary, timeZone: string): string[] {
  const title = activity.name ? esc(activity.name) : esc(capitalize(activity.sport));
  const lines = [
    `${sportEmoji(activity.sport)} <b>${title}</b>`,
    italic(formatDayTime(activity.startedAt, timeZone)),
  ];
  const main = [];
  if (activity.distanceMeters) main.push(`📏 ${formatKm(activity.distanceMeters)}`);
  main.push(`⏱️ ${formatDuration(activity.durationSeconds)}`);
  if (activity.avgPacePerKm) main.push(formatPace(activity.avgPacePerKm));
  lines.push(main.join(" · "));
  const effort = [];
  if (activity.avgHr) {
    effort.push(`💓 ${activity.avgHr}${activity.maxHr ? ` / ${activity.maxHr}` : ""} bpm`);
  }
  if (activity.avgPower) effort.push(`⚡ ${Math.round(activity.avgPower)} W`);
  if (activity.elevationGainMeters && activity.elevationGainMeters >= 20) {
    effort.push(`⛰️ ${Math.round(activity.elevationGainMeters)} m`);
  }
  if (activity.trainingLoad) effort.push(`effort ${Math.round(activity.trainingLoad)}`);
  if (effort.length > 0) lines.push(effort.join(" · "));
  return lines;
}

// A newly synced activity: the numbers, then the model's comment (null when over budget).
export function activityText(
  activity: ActivitySummary,
  timeZone: string,
  comment: string | null,
): string {
  const header = activityHeader(activity, timeZone).join("\n");
  return comment ? `${header}\n\n${markdownToHtml(comment)}` : header;
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

function totalsLine(totals: SportTotals): string {
  const parts = [`${totals.sessions}×`, formatDuration(totals.durationSeconds)];
  if (totals.distanceMeters > 0) parts.push(formatKm(totals.distanceMeters));
  if (totals.elevationGainMeters >= 50) {
    parts.push(`${Math.round(totals.elevationGainMeters)} m D+`);
  }
  return `${sportEmoji(totals.sport)} ${esc(totals.sport)}: ${parts.join(" · ")}`;
}

export function statusText(status: StatusSummary): string {
  const week =
    status.weekTotals.length > 0 ? status.weekTotals.map(totalsLine) : ["Nothing logged yet."];
  if (status.lastActivity) {
    const last = status.lastActivity;
    week.push(
      `<i>Last: ${esc(formatDayTime(last.startedAt, status.timeZone))}, ${esc(last.name ?? last.sport)}</i>`,
    );
  }
  const health = status.latestHealth;
  const recovery = health
    ? section(`😴 Recovery <i>(${health.date})</i>`, recoveryLines(health))
    : section("😴 Recovery", ["No health data yet."]);
  const left = status.capEur - status.spendEur;
  return [
    `📊 <b>Status</b>\n🗓️ Phase: ${esc(status.phase)}`,
    section(`This week <i>(since Mon ${status.weekStart})</i>`, week),
    recovery,
    section("⚙️ Connections", [
      `Strava: ${status.stravaConnected ? "✅ connected" : "❌ not connected (/connect)"}`,
      `Budget: ${eur(left)} left of ${eur(status.capEur)} · ${LEVEL_DESCRIPTIONS[status.level]}`,
    ]),
  ].join("\n\n");
}

function recoveryLines(row: HealthMetrics): string[] {
  const parts = healthParts(row);
  return parts.length > 0 ? parts.map((part) => `• ${esc(capitalize(part))}`) : ["No values."];
}

export function connectText(provider: "Strava" | "Google Calendar", url: string): string {
  return `🔗 <b>Connect ${provider}</b>\n${link(`Open this link to connect ${provider}`, url)}\n<i>Valid for 10 minutes, works once.</i>`;
}

export function googleConnectedText(): string {
  return "✅ <b>Google Calendar connected.</b> Confirmed plans will be booked into it.";
}

export function stravaConnectedText(): string {
  return "✅ <b>Strava connected.</b> New activities will show up here with a short summary.";
}

export function stravaRevokedText(): string {
  return "⚠️ <b>Strava access was revoked</b>, so I no longer get your activities. Send /reauth strava to link it again.";
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
    return `⚠️ <b>${provider} access expired</b>\n${provider} rejected the access renewal (access revoked or expired), so I can't ${what}. Send ${command} to connect it again.`;
  }
  return `⚠️ <b>${provider} access renewal failed</b>\n3 attempts failed (${provider} didn't answer properly). It's logged, and I'll try again next time it's needed. If this keeps coming back, send ${command}.`;
}

export function activityFailureText(): string {
  return "⚠️ Something broke while processing a Strava activity. It's logged; I'll look into it.";
}

export function backgroundFailureText(label: string): string {
  return `⚠️ Background task ${code(label)} failed. It's logged.`;
}

export function serverFailureText(route: string): string {
  const what = route.startsWith("/webhook/strava")
    ? "receiving a Strava update"
    : route.startsWith("/auth/")
      ? "connecting an account"
      : `handling ${code(route)}`;
  return `⚠️ Something broke while ${what}. It's logged; I'll look into it.`;
}

const JOB_DESCRIPTIONS: Record<string, string> = {
  "intervals-wellness": "Fetching health data from Intervals.icu",
  "intervals-profile": "Fetching thresholds and zones from Intervals.icu",
  "sunday-recap": "Starting the Sunday recap",
  "conversation-memory": "Summarizing old conversations",
};

const jobName = (name: string) => JOB_DESCRIPTIONS[name] ?? `The ${esc(name)} job`;

export function jobFailureText(name: string, error: unknown): string {
  const hint =
    error instanceof IntervalsApiError && (error.status === 401 || error.status === 403)
      ? ` The API key was rejected; check ${code("INTERVALS_API_KEY")}.`
      : "";
  return `⚠️ <b>${jobName(name)} failed.</b>${hint} It's logged; I'll retry on the next run and tell you when it works again.`;
}

export function jobRecoveredText(name: string): string {
  return `✅ ${jobName(name)} works again.`;
}

export function recapQuestionText(weekStart: string): string {
  return [
    "📝 <b>Weekly recap time</b>",
    `How did the week go? Any niggles, fatigue, illness, or things I should know about the week of Mon ${weekStart} (travel, busy days, a race)?`,
    "",
    "<i>Your next message is the feedback I'll plan from.</i>",
  ].join("\n");
}

export function onboardingIntroText(): string {
  return [
    "👋 <b>Let's set up your profile</b>",
    "So plans start at the right level. A few questions, answer in your own words (you can skip any):",
    "",
    "<b>1.</b> How many years have you trained per sport (run, bike, swim, others), and how many hours does a typical week have?",
    "",
    "<b>2.</b> Any races in the last ~18 months? Date, event, distance and time.",
    "",
    "<i>Availability, injuries and thresholds come next. I'll show you everything to confirm before saving.</i>",
  ].join("\n");
}

const PRIORITY_EMOJI: Record<string, string> = { A: "🥇", B: "🥈", C: "🥉" };

export function goalsText(season: SeasonView, today: string): string {
  if (season.upcoming.length === 0) {
    return `🎯 No active goals. Tell me your target race, e.g. <i>"my main goal for 2027 is sub-4:45 at 70.3 Pula on 2027-09-26"</i>.`;
  }
  const block = (goal: GoalWithEvent) => {
    const { weeks, days } = weeksAndDaysUntil(goal.event.date, today);
    const what = [goal.event.sport, goal.event.distance].filter(Boolean).join(", ");
    const target = goal.target ? `${goal.goalType}, ${goal.target}` : goal.goalType;
    return [
      `${PRIORITY_EMOJI[goal.priority] ?? "🏅"} ${bold(goal.event.name)} · ${goal.priority} race`,
      `${esc(what)} · ${goal.event.date}`,
      `⏳ <b>${weeks} weeks</b> to go (${days} days)`,
      `Goal: ${esc(target)}`,
    ].join("\n");
  };
  return [
    "🎯 <b>Season goals</b>",
    ...season.upcoming.map(block),
    `🗓️ Phase: <b>${esc(season.phase ?? "unknown (no A goal)")}</b>`,
  ].join("\n\n");
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
  const markerLines: string[] = [];
  if (markers.length === 0) markerLines.push("None yet.");
  for (const m of markers) {
    const stale = isStale(m.measuredOn, today, season.phase) ? "\n   ⚠️ <b>stale, test due</b>" : "";
    markerLines.push(
      `${sportEmoji(m.sport)} ${esc(m.sport)}: <b>${esc(formatMarkerValue(m.metric, m.value))}</b>\n   <i>${describeSource(m.source)}, ${m.measuredOn} (${describeAge(m.measuredOn, today)})</i>${stale}`,
    );
  }
  for (const missing of missingAnchors(markers, recentSports)) {
    markerLines.push(
      `${sportEmoji(missing.sport)} ${missing.sport}: no threshold yet\n   <i>I'll plan by RPE and schedule ${esc(missing.fieldTest)}</i>`,
    );
  }
  const ftp = markers.find((m) => m.sport === "bike" && m.metric === "ftp_w");
  const weight = latestWeight(body, today);
  if (ftp && weight) {
    markerLines.push(
      `${sportEmoji("bike")} bike: <b>${wattsPerKg(ftp.value, weight.weightKg).toFixed(2)} W/kg</b>\n   <i>weight ${weight.weightKg.toFixed(1)} kg on ${weight.date}</i>`,
    );
  }

  const weeks = weeklyBody(body, bodyFrom, 8);
  const change = bodyChange(weeks);
  const bodyLines = weeks.length === 0 ? ["No readings yet."] : [];
  for (const week of weeks.slice(-4)) bodyLines.push(`• ${esc(describeBodyWeek(week))}`);
  if (change) bodyLines.push(`<b>${esc(describeBodyChange(change))}</b>`);

  // Zones are long and rarely read: folded into an expandable quote.
  const zoneSets = listZoneSets(profile?.sportZones);
  const zones =
    zoneSets.length === 0
      ? "None yet."
      : quote(
          zoneSets
            .map(({ sport, kind, set }) => {
              const { source, zones: bands, unitLabel } = zoneSetParts(set);
              return [
                `${sportEmoji(sport)} <b>${sport} ${kind}</b> <i>(${esc(source)})</i>`,
                ...bands.map((band) => `${esc(band)} ${esc(unitLabel)}`),
              ].join("\n");
            })
            .join("\n\n"),
          true,
        );

  const background = parseBackground(profile?.background);
  const backgroundLines: string[] = [];
  if (!background) {
    backgroundLines.push("Not collected yet (/onboard).");
  } else {
    if (background.years_by_sport.length > 0) {
      backgroundLines.push(
        `• Years: ${esc(background.years_by_sport.map((y) => `${y.sport} ${y.years}`).join(", "))}`,
      );
    }
    if (background.typical_weekly_hours != null) {
      backgroundLines.push(`• Typical week: ${background.typical_weekly_hours} h`);
    }
    for (const r of background.recent_results) backgroundLines.push(`• ${r.date}: ${esc(r.event)}`);
    if (background.notes) backgroundLines.push(`• ${esc(background.notes)}`);
  }
  const availability = profile?.preferences?.availability;
  if (typeof availability === "string")
    backgroundLines.push(`• Availability: ${esc(availability)}`);
  if (profile?.injuryNotes) backgroundLines.push(`• Injuries: ${esc(profile.injuryNotes)}`);

  return [
    "👤 <b>Profile</b>",
    section("📈 Fitness markers", markerLines),
    section("⚖️ Body composition <i>(weekly averages)</i>", bodyLines),
    section("🎚️ Zones", [zones]),
    section("📝 Background", backgroundLines),
    "<i>To change something: /profile help, or just tell me in chat.</i>",
  ].join("\n\n");
}

export function profileEditHelpText(): string {
  const example = (text: string, note?: string) =>
    `${code(text)}${note ? ` <i>${esc(note)}</i>` : ""}`;
  return [
    "✏️ <b>Edit your profile</b>\nYou confirm each change with a button.",
    section("Thresholds", [
      example("/profile ftp 250"),
      example("/profile lthr run 168", "(or bike, swim)"),
      example("/profile maxhr 190", "(or /profile maxhr run 192)"),
      example("/profile pace 4:15", "(run threshold pace per km)"),
      example("/profile css 1:45", "(swim, per 100 m)"),
      example("/profile vdot 48.5"),
      example("/profile vdot 10k 45:30", "(from a race)"),
    ]),
    section("About you", [
      example("/profile availability Mon rest, Tue/Thu 6:30-7:45, long ride Sat"),
      example("/profile injuries none"),
      example("/profile name Alex"),
    ]),
    `💡 Add a date to a threshold when it wasn't today: ${code("/profile ftp 250 2026-09-20")}. Zones follow the thresholds automatically. Goals are set in chat.`,
  ].join("\n\n");
}

// A /profile edit that didn't parse: the reason, then the syntax.
export function profileEditErrorText(error: string): string {
  return `${esc(error)}\n\n${profileEditHelpText()}`;
}

export function planCommandText(plan: WeekPlan | null, pendingPlan: boolean): string {
  const pending = pendingPlan
    ? "\n\n⏳ <i>A plan proposal is waiting for your confirmation above.</i>"
    : "";
  if (!plan) return `📅 No confirmed plan for this week. Send /recap to make one.${pending}`;
  return `${planHtml(plan)}${pending}`;
}

export function tomorrowText(plan: WeekPlan | null, tomorrow: string): string {
  const sessions = sortedWorkouts(plan?.workouts ?? []).filter((w) => w.date === tomorrow);
  if (!plan) return `📅 No confirmed plan covers tomorrow (${tomorrow}). Send /recap to make one.`;
  if (sessions.length === 0) return `💤 Tomorrow (${tomorrow}) is a rest day.`;
  return [`📅 <b>Tomorrow</b> <i>(${tomorrow})</i>`, ...sessions.map(workoutHtml)].join("\n\n");
}

// The confirm/cancel result of a proposal button.
export function actionResultText(result: string): string {
  return esc(result);
}

export function importText(summary: ImportSummary): string {
  const lines = ["📥 <b>History import</b>"];
  const { activities, wellnessDays } = summary;
  if (activities === null) lines.push("➖ Strava: not connected (/connect strava)");
  else if (activities === "failed")
    lines.push("❌ Strava: failed, it's logged. Try /import again later.");
  else {
    lines.push(
      `✅ Strava: ${activities.fetched} activities from the last 12 months, ${activities.inserted} new`,
    );
  }
  if (wellnessDays === null) lines.push("➖ Intervals.icu: not configured");
  else if (wellnessDays === "failed")
    lines.push("❌ Intervals.icu: failed, it's logged. Try /import again later.");
  else lines.push(`✅ Intervals.icu: ${wellnessDays} days of wellness data (last 90 days)`);
  lines.push("", "<i>Running it again only fills gaps; nothing is duplicated.</i>");
  return lines.join("\n");
}

import { formatDuration, formatKm, formatPace } from "../../agent/activity-format.js";
import { sportEmoji } from "../../bot/html.js";
import type { ActivitySummary } from "../../db/activities.js";
import type { ActivityFeedback } from "../../db/activity-feedback.js";
import type { SessionRecord } from "../../db/planned-workouts.js";
import { workoutOf } from "../../db/training-plans.js";
import { longerThanPlanned } from "../../training/completion.js";
import type { Step, StepBlock } from "../../training/plan.js";
import { esc } from "../../utils/html.js";
import {
  DASHBOARD_PATH,
  dayLabel,
  longDate,
  minutes,
  statusLabel,
  swimPace,
  typeLabel,
} from "./format.js";
import { page } from "./layout.js";
import { sessionPath, weekPath } from "./week.js";

const STATUS_SOURCE: Record<string, string> = {
  match: "matched to the activity",
  athlete: "your answer",
  timeout: "no answer within 3 days",
  plan_change: "plan change",
  backfill: "set when the plan history was imported",
};

const pairs = (entries: readonly (readonly [string, string | null | undefined])[]) =>
  `<dl>${entries
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .map(([term, value]) => `<dt>${esc(term)}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;

function stepTarget(step: Step, sport: string): string {
  const target = step.target;
  if (!target) return "";
  const range = (format: (value: number) => string) =>
    target.min === target.max ? format(target.min) : `${format(target.min)}–${format(target.max)}`;
  switch (target.metric) {
    case "power":
      return `${range((value) => String(Math.round(value)))} W`;
    case "hr":
      return `${range((value) => String(Math.round(value)))} bpm`;
    case "pace":
      return sport === "swim" ? range(swimPace) : range(formatPace);
  }
}

function stepsTable(blocks: readonly StepBlock[], sport: string): string {
  const rows = blocks
    .map((block) => {
      const repeat = block.repeat > 1 ? `<tr><th colspan="4">${block.repeat} ×</th></tr>` : "";
      return (
        repeat +
        block.steps
          .map((step) => {
            const amount = step.distance_meters
              ? `${Math.round(step.distance_meters)} m`
              : step.duration_seconds
                ? formatDuration(step.duration_seconds)
                : "";
            return `<tr><td class="wrap">${esc(step.label)}</td><td>${esc(step.intensity)}</td><td>${esc(amount)}</td><td>${esc(stepTarget(step, sport))}</td></tr>`;
          })
          .join("")
      );
    })
    .join("");
  return `<div class="table"><table><thead><tr><th>Step</th><th>Kind</th><th>Amount</th><th>Target</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function plannedCard(record: SessionRecord): string {
  const { session } = record;
  const workout = workoutOf(session);
  const structure = workout?.structure.length
    ? `<h2>Structure</h2><ul class="plain">${workout.structure.map((segment) => `<li><b>${esc(segment.segment)}</b> ${esc(segment.description)}</li>`).join("")}</ul>`
    : "";
  const steps = workout?.steps?.length
    ? `<h2>Watch steps</h2>${stepsTable(workout.steps, session.sport)}`
    : "";
  const links = [
    session.brickWith !== null
      ? `<a href="${sessionPath(session.brickWith)}">Bike leg of this brick</a>`
      : null,
    session.replacedBy !== null
      ? `<a href="${sessionPath(session.replacedBy)}">The session that replaced it</a>`
      : null,
  ].filter((link) => link !== null);
  return `<section class="card"><h2>Planned</h2>${pairs([
    ["Type", esc(typeLabel(session.sessionType))],
    ["Intensity", esc(session.intensity)],
    ["Start", esc(session.startTime)],
    [
      "Duration",
      esc(
        session.activeMinutes === session.durationMinutes
          ? minutes(session.durationMinutes)
          : `${minutes(session.durationMinutes)} (${minutes(session.activeMinutes)} active)`,
      ),
    ],
    ["Targets", session.targets ? esc(session.targets) : null],
    ["Field test", session.fieldTest ? esc(session.fieldTest) : null],
  ])}${structure}${steps}${session.notes ? `<h2>Notes</h2><p class="note">${esc(session.notes)}</p>` : ""}${links.length > 0 ? `<p>${links.join(" · ")}</p>` : ""}</section>`;
}

function activityCard(activity: ActivitySummary, sport: string): string {
  const pace =
    sport === "swim" && activity.distanceMeters
      ? swimPace(activity.durationSeconds / (activity.distanceMeters / 100))
      : activity.avgPacePerKm
        ? formatPace(activity.avgPacePerKm)
        : null;
  const laps = activity.laps?.length
    ? `<h2>Laps</h2><div class="table"><table><thead><tr><th>Lap</th><th>Time</th><th>Distance</th><th>HR</th><th>Power</th></tr></thead><tbody>${activity.laps
        .map(
          (lap, i) =>
            `<tr><td class="wrap">${esc(lap.name || `Lap ${i + 1}`)}</td><td>${esc(formatDuration(lap.movingSeconds))}</td><td>${lap.distanceMeters ? esc(formatKm(lap.distanceMeters)) : ""}</td><td>${lap.avgHr ? Math.round(lap.avgHr) : ""}</td><td>${lap.avgWatts ? `${Math.round(lap.avgWatts)} W` : ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : "";
  return `<section class="card"><h2>Done</h2>${pairs([
    ["Activity", activity.name ? esc(activity.name) : esc(activity.sport)],
    ["Moving time", esc(formatDuration(activity.durationSeconds))],
    [
      "Elapsed",
      activity.elapsedSeconds && activity.elapsedSeconds !== activity.durationSeconds
        ? esc(formatDuration(activity.elapsedSeconds))
        : null,
    ],
    ["Distance", activity.distanceMeters ? esc(formatKm(activity.distanceMeters)) : null],
    ["Pace", pace ? esc(pace) : null],
    ["Power", activity.avgPower ? `${Math.round(activity.avgPower)} W` : null],
    [
      "Heart rate",
      activity.avgHr
        ? `${activity.avgHr} avg${activity.maxHr ? ` / ${activity.maxHr} max` : ""}`
        : null,
    ],
    [
      "Climb",
      activity.elevationGainMeters ? `${Math.round(activity.elevationGainMeters)} m` : null,
    ],
    ["Relative effort", activity.trainingLoad ? String(Math.round(activity.trainingLoad)) : null],
  ])}${laps}</section>`;
}

function feedbackCard(feedback: ActivityFeedback): string {
  return `<section class="card"><h2>Feedback</h2>${pairs([
    [
      "RPE",
      feedback.rpe
        ? `${feedback.rpe}/10${feedback.rpeSource === "strava" ? " (Strava)" : ""}`
        : null,
    ],
    ["Feel", feedback.feel ? esc(feedback.feel) : null],
    ["Pain", feedback.pain === null ? null : feedback.pain ? "yes" : "no"],
    ["Pain note", feedback.painNote ? esc(feedback.painNote) : null],
    ["Note", feedback.note ? `<span class="note">${esc(feedback.note)}</span>` : null],
  ])}</section>`;
}

export function sessionPage(record: SessionRecord): string {
  const { session, activity, feedback } = record;
  const source = session.statusSource ? STATUS_SOURCE[session.statusSource] : null;
  const longer =
    activity &&
    session.status === "done" &&
    longerThanPlanned(session.activeMinutes, activity.durationSeconds)
      ? " · longer than planned"
      : "";
  const done = activity
    ? activityCard(activity, session.sport)
    : `<section class="card"><h2>Done</h2><p class="muted">No activity linked to this session.</p></section>`;
  return page(
    session.title,
    "week",
    `<div class="pager"><a href="${weekPath(session.weekStart)}">← Week of ${esc(longDate(session.weekStart))}</a><a href="${DASHBOARD_PATH}/types/${session.sessionType}">${esc(typeLabel(session.sessionType))} history</a></div><h1>${sportEmoji(session.sport)} ${esc(session.title)}</h1><p class="sub">${esc(dayLabel(session.date))} · <span class="chip s-${session.status}">${statusLabel(session.status)}</span>${source ? ` <span class="muted">(${esc(source)})</span>` : ""}${esc(longer)}</p><div class="cols">${plannedCard(record)}<div>${done}${feedback ? feedbackCard(feedback) : ""}</div></div>`,
  );
}

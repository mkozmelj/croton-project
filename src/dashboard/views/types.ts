import { formatPace } from "../../agent/activity-format.js";
import { sportEmoji } from "../../bot/html.js";
import { lowerIsBetter } from "../../training/progress.js";
import { esc } from "../../utils/html.js";
import { progressChart } from "../charts.js";
import type { TypeModel, TypeSummary } from "../models.js";
import {
  DASHBOARD_PATH,
  longDate,
  metricLabel,
  metricValue,
  minutes,
  shortDate,
  statusLabel,
  typeLabel,
} from "./format.js";
import { page } from "./layout.js";
import { sessionPath } from "./week.js";

export const typePath = (type: string) => `${DASHBOARD_PATH}/types/${type}`;

export function typesPage(summaries: readonly TypeSummary[]): string {
  const rows = summaries
    .map(({ type, sessions, completed, latest }) => {
      const value =
        latest && latest.value !== null ? metricValue(latest.spec.metric, latest.value) : "";
      return `<a class="row" href="${typePath(type)}"><span class="main"><span class="title">${esc(typeLabel(type))}</span><span class="meta">${sessions} planned · ${completed} completed</span></span><span class="side">${esc(value)}${latest ? `<small>${esc(shortDate(latest.record.session.date))}</small>` : ""}</span></a>`;
    })
    .join("");
  return page(
    "Session types",
    "types",
    `<h1>Session types</h1><p class="sub">Each family of sessions over time, with the number that shows its progress.</p>${rows || '<p class="muted">No planned sessions yet.</p>'}`,
  );
}

export function typePage(model: TypeModel): string {
  const { spec } = model;
  const charted = model.points.filter(
    (point) => point.value !== null && point.spec.metric === spec.metric,
  );
  const chart = progressChart(
    charted.map((point) => ({
      date: point.record.session.date,
      value: point.value ?? 0,
      partial: point.record.session.status === "partial",
      title: `${longDate(point.record.session.date)} · ${point.record.session.title}: ${metricValue(spec.metric, point.value ?? 0)}${point.activity.avgHr ? `, HR ${point.activity.avgHr}` : ""}`,
    })),
    { invert: lowerIsBetter(spec.metric), format: (value) => metricValue(spec.metric, value) },
  );
  const rows = [...model.sessions]
    .reverse()
    .map(({ session, activity, feedback }) => {
      const point = model.points.find((p) => p.record.session.id === session.id);
      const value =
        point && point.value !== null ? metricValue(point.spec.metric, point.value) : "";
      const pace =
        activity?.avgPacePerKm && (session.sport === "run" || session.sport === "trail_run")
          ? formatPace(activity.avgPacePerKm)
          : "";
      return `<tr><td><a href="${sessionPath(session.id)}">${esc(shortDate(session.date))}</a></td><td class="wrap">${sportEmoji(session.sport)} ${esc(session.title)}</td><td><span class="chip s-${session.status}">${statusLabel(session.status)}</span></td><td>${esc(`${session.activeMinutes}/${activity ? Math.round(activity.durationSeconds / 60) : "–"}`)}</td><td>${esc(value)}</td><td>${spec.metric === "duration" ? esc(pace) : ""}${activity?.avgHr ? ` ${activity.avgHr}` : ""}</td><td>${feedback?.rpe ?? ""}${feedback?.feel ? ` ${esc(feedback.feel)}` : ""}</td></tr>`;
    })
    .join("");
  const chartCard = chart
    ? `<section class="card">${chart}<div class="legend"><span><i class="key k1"></i>${esc(spec.label)}</span>${lowerIsBetter(spec.metric) ? "<span>faster is up</span>" : ""}<span>amber: partial</span></div></section>`
    : `<p class="muted">No completed session with a ${esc(spec.label)} number yet.</p>`;
  return page(
    typeLabel(model.type),
    "types",
    `<div class="pager"><a href="${DASHBOARD_PATH}/types">← Session types</a></div><h1>${esc(typeLabel(model.type))}</h1><p class="sub">Progress shown: ${esc(spec.label)} (whole activity) · ${model.sessions.length} sessions · ${esc(minutes(model.sessions.reduce((sum, { session }) => sum + session.activeMinutes, 0)))} planned in all</p>${chartCard}<div class="table"><table><thead><tr><th>Date</th><th>Session</th><th>Status</th><th>Min plan/done</th><th>${metricLabel(spec.metric)}</th><th>${spec.metric === "duration" ? "Pace, HR" : "HR"}</th><th>RPE, feel</th></tr></thead><tbody>${rows}</tbody></table></div>`,
  );
}

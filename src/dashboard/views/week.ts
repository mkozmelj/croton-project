import { sportEmoji } from "../../bot/html.js";
import type { ActivitySummary } from "../../db/activities.js";
import type { SessionRecord } from "../../db/planned-workouts.js";
import { formatRate, longerThanPlanned } from "../../training/completion.js";
import type { WeekHeader } from "../../training/plan.js";
import { addDays } from "../../utils/dates.js";
import { esc } from "../../utils/html.js";
import type { WeekModel } from "../models.js";
import {
  activityShort,
  DASHBOARD_PATH,
  dayLabel,
  hours,
  longDate,
  minutes,
  shortDate,
  statusLabel,
  typeLabel,
} from "./format.js";
import { page } from "./layout.js";

export const weekPath = (weekStart: string) => `${DASHBOARD_PATH}/week/${weekStart}`;
export const sessionPath = (id: number) => `${DASHBOARD_PATH}/session/${id}`;

export function sessionRow({ session, activity }: SessionRecord): string {
  const actual = activity
    ? `<span class="v">${esc(activityShort(activity))}</span>${session.status === "done" && longerThanPlanned(session.activeMinutes, activity.durationSeconds) ? "<small>longer than planned</small>" : ""}`
    : "";
  return `<a class="row s-${session.status}" href="${sessionPath(session.id)}"><span class="icon" aria-hidden="true">${sportEmoji(session.sport)}</span><span class="main"><span class="title">${esc(session.title)}</span><span class="meta">${esc(typeLabel(session.sessionType))} · ${esc(minutes(session.activeMinutes))} planned</span></span><span class="side">${actual}<span class="chip">${statusLabel(session.status)}</span></span></a>`;
}

function unplannedRow(activity: ActivitySummary): string {
  const name = activity.name ? esc(activity.name) : esc(activity.sport);
  return `<div class="row unplanned"><span class="icon" aria-hidden="true">${sportEmoji(activity.sport)}</span><span class="main"><span class="title">${name}</span><span class="meta">Unplanned</span></span><span class="side">${esc(activityShort(activity))}</span></div>`;
}

export function weekPage(
  model: WeekModel,
  header: WeekHeader | null,
  { today }: { today: string },
): string {
  const { weekStart, completion } = model;
  const isCurrent = weekStart <= today && today < addDays(weekStart, 7);
  const pager = `<div class="pager"><a href="${weekPath(addDays(weekStart, -7))}">← ${esc(shortDate(addDays(weekStart, -7)))}</a>${isCurrent ? "" : `<a href="${DASHBOARD_PATH}">This week</a>`}<a href="${weekPath(addDays(weekStart, 7))}">${esc(shortDate(addDays(weekStart, 7)))} →</a></div>`;
  const counted =
    completion.counted === 0
      ? "nothing to count yet"
      : `${completion.done} done, ${completion.partial} partial, ${completion.skipped} skipped`;
  const tiles = `<div class="tiles"><div class="tile"><b>${formatRate(completion.sessionsRate)}</b><span>sessions</span></div><div class="tile"><b>${formatRate(completion.hoursRate)}</b><span>hours</span></div><div class="tile"><b>${esc(hours(model.actualSeconds / 60))}</b><span>of ${esc(hours(model.plannedMinutes))} planned</span></div></div>`;
  const focus = header ? `<p class="focus">${esc(header.focus)}</p>` : "";
  const days = model.days
    .map((day) => {
      const rows = [...day.sessions.map(sessionRow), ...day.unplanned.map(unplannedRow)];
      return `<section class="day${day.date === today ? " today" : ""}"><h3>${esc(dayLabel(day.date))}${day.date === today ? " · today" : ""}</h3>${rows.length > 0 ? rows.join("") : '<div class="rest">Rest</div>'}</section>`;
    })
    .join("");
  const noPlan =
    model.days.every((day) => day.sessions.length === 0) && !header
      ? '<p class="muted">No confirmed plan for this week.</p>'
      : "";
  return page(
    `Week of ${shortDate(weekStart)}`,
    "week",
    `${pager}<h1>Week of ${esc(longDate(weekStart))}</h1><p class="sub">${header?.phase ? `${esc(header.phase)} phase · ` : ""}${esc(counted)}</p>${tiles}${focus}${noPlan}${days}`,
  );
}

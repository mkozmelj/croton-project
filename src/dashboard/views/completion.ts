import type { SessionRecord } from "../../db/planned-workouts.js";
import { type Completion, formatRate } from "../../training/completion.js";
import { esc } from "../../utils/html.js";
import { rateChart } from "../charts.js";
import type { CompletionModel } from "../models.js";
import { dayLabel, hours, longDate, shortDate } from "./format.js";
import { page } from "./layout.js";
import { sessionRow, weekPath } from "./week.js";

function summary(label: string, completion: Completion): string {
  return `<div class="tile"><b>${formatRate(completion.sessionsRate)}</b><span>sessions, ${esc(label)}<br>${formatRate(completion.hoursRate)} of hours</span></div>`;
}

function list(title: string, records: readonly SessionRecord[], empty: string): string {
  const rows = records
    .map(
      (record) =>
        `<h3 class="muted">${esc(dayLabel(record.session.date))}</h3>${sessionRow(record)}`,
    )
    .join("");
  return `<h2>${esc(title)} (${records.length})</h2>${records.length > 0 ? `<div class="day">${rows}</div>` : `<p class="muted">${esc(empty)}</p>`}`;
}

export function completionPage(model: CompletionModel): string {
  const chart = rateChart(
    model.weeks.map(({ weekStart, completion }) => ({
      label: shortDate(weekStart),
      sessionsRate: completion.sessionsRate,
      hoursRate: completion.hoursRate,
      title: `Week of ${longDate(weekStart)}`,
    })),
  );
  const table = `<div class="table"><table><thead><tr><th>Week</th><th>Sessions</th><th>Hours</th><th>Done</th><th>Partial</th><th>Skipped</th><th>Active time</th></tr></thead><tbody>${[
    ...model.weeks,
  ]
    .reverse()
    .map(
      ({ weekStart, completion: c }) =>
        `<tr><td><a href="${weekPath(weekStart)}">${esc(shortDate(weekStart))}</a></td><td>${formatRate(c.sessionsRate)}</td><td>${formatRate(c.hoursRate)}</td><td>${c.done}</td><td>${c.partial}</td><td>${c.skipped}</td><td>${c.counted > 0 ? esc(`${hours(c.completedMinutes)} / ${hours(c.plannedMinutes)}`) : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
  return page(
    "Completion",
    "completion",
    `<h1>Completion</h1><p class="sub">Done sessions count fully, partial ones half. Upcoming and unanswered sessions don't count yet.</p><div class="tiles">${summary("last 4 weeks", model.lastFourWeeks)}${summary(`${model.weeks.length} weeks`, model.overall)}<div class="tile"><b>${model.overall.skipped}</b><span>skipped in ${model.weeks.length} weeks</span></div></div><section class="card">${chart}<div class="legend"><span><i class="key k1"></i>Sessions</span><span><i class="key k2"></i>Hours</span></div></section>${table}${list("Skipped", model.skipped, "Nothing skipped.")}${list("Partial", model.partial, "Nothing partial.")}`,
  );
}

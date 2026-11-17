import { esc } from "../utils/html.js";

// ADR-022: charts are inline SVG drawn here, no JavaScript. Colours come from the page's CSS
// classes (light and dark), so nothing here knows the theme. Every value has a <title>, which
// browsers show on hover and screen readers read.

const round = (value: number) => Math.round(value * 10) / 10;

export type RateBar = {
  label: string;
  // 0-1, null when nothing counted that week.
  sessionsRate: number | null;
  hoursRate: number | null;
  title: string;
};

// Two bars per week (sessions %, hours %) on a 0-100% scale, with guides at 50% and 80%.
export function rateChart(weeks: readonly RateBar[]): string {
  const width = 420;
  const height = 180;
  const left = 34;
  const right = 6;
  const top = 8;
  const bottom = 22;
  const plotHeight = height - top - bottom;
  const slot = (width - left - right) / Math.max(1, weeks.length);
  const bar = Math.min(14, (slot - 4) / 2);
  const y = (rate: number) => top + plotHeight * (1 - Math.min(1, Math.max(0, rate)));

  const guides = [0, 0.5, 0.8, 1]
    .map(
      (rate) =>
        `<line class="grid${rate === 0 ? " base" : ""}" x1="${left}" x2="${width - right}" y1="${round(y(rate))}" y2="${round(y(rate))}"/>` +
        `<text class="axis" x="${left - 6}" y="${round(y(rate) + 4)}" text-anchor="end">${rate * 100}%</text>`,
    )
    .join("");

  const bars = weeks
    .map((week, i) => {
      const center = left + slot * i + slot / 2;
      // Every other label when they'd crowd, always the latest week.
      const labelled = weeks.length <= 8 || (weeks.length - 1 - i) % 2 === 0;
      const rect = (rate: number | null, x: number, cls: string, what: string) =>
        rate === null
          ? ""
          : `<rect class="${cls}" x="${round(x)}" y="${round(y(rate))}" width="${round(bar)}" height="${round(Math.max(1, y(0) - y(rate)))}" rx="2"><title>${esc(`${week.title}: ${what} ${Math.round(rate * 100)}%`)}</title></rect>`;
      const empty =
        week.sessionsRate === null && week.hoursRate === null
          ? `<text class="axis" x="${round(center)}" y="${round(y(0) - 4)}" text-anchor="middle">–</text>`
          : "";
      return (
        rect(week.sessionsRate, center - bar - 1, "bar-sessions", "sessions") +
        rect(week.hoursRate, center + 1, "bar-hours", "hours") +
        empty +
        (labelled
          ? `<text class="axis" x="${round(center)}" y="${height - 6}" text-anchor="middle">${esc(week.label)}</text>`
          : "")
      );
    })
    .join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Completion per week">${guides}${bars}</svg>`;
}

export type ProgressDot = {
  // Local date, YYYY-MM-DD.
  date: string;
  value: number;
  partial: boolean;
  title: string;
};

// The progress number over time: dots on a line, x by date. With `invert` (paces) the axis is
// turned over so that better is always up.
export function progressChart(
  dots: readonly ProgressDot[],
  { invert, format }: { invert: boolean; format: (value: number) => string },
): string {
  if (dots.length === 0) return "";
  const width = 420;
  const height = 180;
  const left = 58;
  const right = 12;
  const top = 12;
  const bottom = 24;

  const values = dots.map((dot) => dot.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = (max - min) * 0.1 || Math.abs(max) * 0.05 || 1;
  min -= pad;
  max += pad;
  const times = dots.map((dot) => Date.parse(`${dot.date}T00:00:00Z`));
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  const x = (time: number) =>
    span === 0
      ? (left + width - right) / 2
      : left + ((time - first) / span) * (width - left - right);
  const y = (value: number) => {
    const share = (value - min) / (max - min);
    return top + (height - top - bottom) * (invert ? share : 1 - share);
  };

  const ticks = [min + pad, (min + max) / 2, max - pad]
    .map(
      (value) =>
        `<line class="grid" x1="${left}" x2="${width - right}" y1="${round(y(value))}" y2="${round(y(value))}"/>` +
        `<text class="axis" x="${left - 6}" y="${round(y(value) + 4)}" text-anchor="end">${esc(format(value))}</text>`,
    )
    .join("");
  const points = dots.map((dot, i) => `${round(x(times[i] ?? first))},${round(y(dot.value))}`);
  const line =
    dots.length > 1 ? `<polyline class="line" points="${points.join(" ")}" fill="none"/>` : "";
  const circles = dots
    .map(
      (dot, i) =>
        `<circle class="${dot.partial ? "dot partial" : "dot"}" cx="${round(x(times[i] ?? first))}" cy="${round(y(dot.value))}" r="4.5"><title>${esc(dot.title)}</title></circle>`,
    )
    .join("");
  const label = (time: number, anchor: string) =>
    `<text class="axis" x="${round(x(time))}" y="${height - 6}" text-anchor="${anchor}">${esc(shortDate(time))}</text>`;
  const axis =
    span === 0 ? label(first, "middle") : label(first, "start") + label(first + span, "end");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Progress over time">${ticks}${line}${circles}${axis}</svg>`;
}

function shortDate(time: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  }).format(new Date(time));
}

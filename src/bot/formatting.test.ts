import { describe, expect, it } from "vitest";
import { IntervalsApiError } from "../integrations/intervals/client.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import type { WeekPlan, Workout } from "../training/plan.js";
import {
  activityText,
  budgetText,
  goalsText,
  jobFailureText,
  planCommandText,
  profileEditErrorText,
  startText,
  tomorrowText,
} from "./formatting.js";

const workout = (overrides: Partial<Workout> = {}): Workout => ({
  date: "2026-09-29",
  start_time: "07:00",
  sport: "run",
  title: "Tempo <intervals>",
  duration_minutes: 55,
  intensity: "hard",
  structure: [
    { segment: "warmup", description: "15 min Z2" },
    { segment: "main", description: "3x8 min Z4 & 3 min jog" },
  ],
  targets: "HR <170",
  field_test: null,
  notes: null,
  ...overrides,
});

const plan = (workouts: Workout[]): WeekPlan => ({
  week_start: "2026-09-28",
  phase: "build",
  focus: "Threshold work",
  workouts,
  weekly_targets: { total_hours: 6, run_km: 40, bike_km: null, swim_km: null, easy_percent: 80 },
});

describe("budgetText", () => {
  it("shows spend, share of the cap and a per-model breakdown", () => {
    const text = budgetText({
      monthLabel: "September 2026",
      spendEur: 1.4,
      capEur: 14,
      level: "normal",
      byModel: [
        { model: "claude-sonnet-5-5", calls: 12, costEur: 1.4, cacheReadInputTokens: 24_000 },
      ],
    });
    expect(text).toContain("▰▱▱▱▱▱▱▱▱▱ 10%\n€1.40 of €14.00");
    expect(text).toContain(
      "• <code>claude-sonnet-5-5</code>: 12 calls · €1.40 · 24,000 cached tokens read",
    );
  });
});

describe("jobFailureText", () => {
  it("points at the API key only when Intervals.icu rejected it", () => {
    const rejected = jobFailureText("intervals-wellness", new IntervalsApiError(401, "/x"));
    expect(rejected).toContain("check <code>INTERVALS_API_KEY</code>");
    const outage = jobFailureText("intervals-wellness", new IntervalsApiError(503, "/x"));
    expect(outage).not.toContain("INTERVALS_API_KEY");
    expect(outage).toMatch(/^⚠️ <b>Fetching health data from Intervals\.icu failed\.<\/b>/);
  });
});

describe("escaping", () => {
  it("escapes the /deep placeholder in the command list", () => {
    expect(startText(1, false)).toContain("/deep &lt;question&gt;");
  });

  it("escapes goal names and the /profile parse error", () => {
    const text = goalsText(
      {
        upcoming: [
          {
            priority: "A",
            goalType: "time",
            target: "<4:45",
            event: {
              name: "Pula & friends",
              date: "2027-09-26",
              sport: "triathlon",
              distance: "70.3",
            },
          },
        ],
        phase: "base",
      } as unknown as Parameters<typeof goalsText>[0],
      "2026-09-27",
    );
    expect(text).toContain("<b>Pula &amp; friends</b>");
    expect(text).toContain("Goal: time, &lt;4:45");
    expect(profileEditErrorText("FTP <50 W?")).toMatch(/^FTP &lt;50 W\?\n\n/);
  });
});

describe("activityText", () => {
  it("shows the numbers, then the model's comment converted from Markdown", () => {
    const text = activityText(storedActivity(), "Europe/Ljubljana", "**Solid** tempo.");
    expect(text).toMatch(/^🏃 <b>Test Tempo<\/b>\n<i>Tue 22 Sept, 07:00<\/i>\n📏 8\.10 km · ⏱️ /);
    expect(text.endsWith("\n\n<b>Solid</b> tempo.")).toBe(true);
  });

  it("is just the numbers without a comment", () => {
    expect(activityText(storedActivity(), "Europe/Ljubljana", null)).not.toContain("\n\n");
  });
});

describe("plans", () => {
  it("groups the week by day, shows rest days, and folds workout structure", () => {
    const text = planCommandText(
      plan([workout(), workout({ date: "2026-10-01", title: "Easy", intensity: "easy" })]),
      true,
    );
    expect(text).toMatch(/^📅 <b>Week of Mon 28 Sept<\/b> · build phase\n<i>Threshold work<\/i>/);
    expect(text).toContain("⏱️ 6 h · 🏃 40 km · 80% easy");
    expect(text).not.toContain("Mon 28 Sept</b> · 💤");
    expect(text).toContain("<b>Wed 30 Sept</b> · 💤 rest");
    expect(text).toContain(
      "🏃 <b>07:00 Tempo &lt;intervals&gt;</b>\n55 min · 🔴 hard · HR &lt;170",
    );
    expect(text).toContain(
      "<blockquote expandable><b>Warm-up:</b> 15 min Z2\n<b>Main set:</b> 3x8 min Z4 &amp; 3 min jog</blockquote>",
    );
    expect(text).toContain("⏳ <i>A plan proposal is waiting");
  });

  it("shows tomorrow's sessions open, and rest days", () => {
    const week = plan([workout({ field_test: "run_lthr_30min" })]);
    const text = tomorrowText(week, "2026-09-29");
    expect(text).toContain("🧪 <b>Field test:</b> 30-min threshold run test");
    expect(text).toContain("<blockquote><b>Warm-up:</b>");
    expect(tomorrowText(week, "2026-09-30")).toBe("💤 Tomorrow (2026-09-30) is a rest day.");
  });
});

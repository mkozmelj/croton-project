import { describe, expect, it } from "vitest";
import type { ActivityFeedback } from "../db/activity-feedback.js";
import type { PlannedWorkoutRow, SessionRecord } from "../db/planned-workouts.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import { historyFrom, sessionHistoryLines, sessionLine } from "./session-history.js";

const NOW = new Date("2026-11-25T10:00:00Z");
const TODAY = "2026-11-25"; // a Wednesday

let nextId = 1;

function row(overrides: Partial<PlannedWorkoutRow>): PlannedWorkoutRow {
  const id = nextId++;
  return {
    id,
    key: `croton:test:${id}`,
    weekStart: "2026-11-16",
    date: "2026-11-20",
    startTime: "07:00",
    sport: "bike",
    sessionType: "bike_threshold",
    title: "Threshold intervals",
    intensity: "hard",
    durationMinutes: 50,
    activeMinutes: 50,
    structure: [
      { segment: "warmup", description: "15 min Z1-Z2" },
      { segment: "main", description: "3x8 min Z4, 4 min Z1 between" },
      { segment: "cooldown", description: "10 min Z1" },
    ],
    steps: null,
    targets: null,
    fieldTest: null,
    notes: null,
    status: "done",
    statusSource: "match",
    activityId: null,
    brickWith: null,
    replacedBy: null,
    calendarEventId: null,
    source: "plan",
    mainSet: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function feedback(overrides: Partial<ActivityFeedback>): ActivityFeedback {
  return {
    id: 1,
    activityId: 1,
    rpe: null,
    rpeSource: null,
    feel: null,
    pain: null,
    painNote: null,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const record = (
  overrides: Partial<PlannedWorkoutRow>,
  extra: Partial<Omit<SessionRecord, "session">> = {},
): SessionRecord => ({ session: row(overrides), activity: null, feedback: null, ...extra });

describe("sessionLine", () => {
  it("shows the main set, planned and done minutes, status and feedback", () => {
    const line = sessionLine(
      record(
        {},
        {
          activity: storedActivity({ durationSeconds: 48 * 60 }),
          feedback: feedback({ rpe: 7, feel: "good", pain: true }),
        },
      ),
    );
    expect(line).toBe(
      '11-20 "Threshold intervals" main: 3x8 min Z4, 4 min Z1 between; 50/48 min, done, RPE 7, felt good, pain reported',
    );
  });

  it("says planned minutes and 'not confirmed' for a past session with no answer", () => {
    expect(sessionLine(record({ status: "upcoming", structure: "not a list" }))).toBe(
      '11-20 "Threshold intervals"; 50 min planned, not confirmed',
    );
  });
});

describe("sessionHistoryLines", () => {
  it("lists the last 3 of each type, most recent type first, oldest session first", () => {
    const lines = sessionHistoryLines(
      [
        record({ date: "2026-10-30", title: "T1" }),
        record({ date: "2026-11-06", title: "T2" }),
        record({ date: "2026-11-13", title: "T3" }),
        record({ date: "2026-11-20", title: "T4" }),
        record({
          date: "2026-11-24",
          sport: "run",
          sessionType: "run_easy",
          title: "Easy run",
          structure: [],
        }),
      ],
      TODAY,
    );
    const typed = lines.filter((line) => /^- (bike|run)_/.test(line));
    expect(typed).toEqual([
      '- run_easy 11-24 "Easy run"; 50 min planned, done',
      expect.stringContaining('- bike_threshold 11-06 "T2"'),
      expect.stringContaining('- bike_threshold 11-13 "T3"'),
      expect.stringContaining('- bike_threshold 11-20 "T4"'),
    ]);
  });

  it("leaves out today and later, replaced rows, and anything before the window", () => {
    const text = sessionHistoryLines(
      [
        record({ date: TODAY, title: "Today" }),
        record({ date: "2026-11-27", title: "Friday" }),
        record({ date: "2026-11-18", title: "Replaced", status: "replaced" }),
        record({ date: "2026-08-01", title: "Old" }),
      ],
      TODAY,
    ).join("\n");
    expect(historyFrom(TODAY)).toBe("2026-09-02");
    for (const title of ["Today", "Friday", "Replaced", "Old"]) {
      expect(text).not.toContain(`"${title}"`);
    }
    expect(text).toContain("- no past sessions yet");
  });

  it("gives the 4-week completion rate and weekday moves and skips", () => {
    const lines = sessionHistoryLines(
      [
        record({ date: "2026-11-18", status: "done" }), // Wed
        record({ date: "2026-11-19", status: "partial" }), // Thu
        record({ date: "2026-11-11", status: "skipped", statusSource: "backfill" }), // Wed
        record({ date: "2026-11-23", status: "upcoming" }), // Mon, no answer yet
        record({ date: "2026-11-04", status: "replaced", statusSource: "plan_change" }), // Wed
        record({ date: "2026-10-01", status: "skipped" }), // Thu, outside 4 weeks
      ],
      TODAY,
    );
    expect(lines).toContain(
      "- Last 4 weeks: sessions 50%, hours 50% (1 done, 1 partial, 1 skipped; 1 not confirmed)",
    );
    expect(lines).toContain(
      "- Moved or skipped by weekday, 12 weeks: Wed 1 skipped, 1 moved; Thu 1 skipped",
    );
  });

  it("says when nothing counts yet", () => {
    const lines = sessionHistoryLines([], TODAY);
    expect(lines).toContain("- Last 4 weeks: nothing counted yet");
    expect(lines).toContain("- Moved or skipped by weekday, 12 weeks: none");
  });
});

import { describe, expect, it } from "vitest";
import { completion, completionSummary, formatRate, longerThanPlanned } from "./completion.js";

describe("completion", () => {
  it("counts done, half of partial and skipped, and ignores the rest", () => {
    const result = completion([
      { status: "done", activeMinutes: 60 },
      { status: "partial", activeMinutes: 40 },
      { status: "skipped", activeMinutes: 100 },
      { status: "upcoming", activeMinutes: 90 },
      { status: "unconfirmed", activeMinutes: 30 },
      { status: "replaced", activeMinutes: 45 },
    ]);
    expect(result).toMatchObject({ counted: 3, done: 1, partial: 1, skipped: 1 });
    expect(result.sessionsRate).toBeCloseTo(1.5 / 3);
    expect(result.plannedMinutes).toBe(200);
    expect(result.completedMinutes).toBe(80);
    expect(result.hoursRate).toBeCloseTo(0.4);
  });

  it("has no rate when nothing counts yet", () => {
    const result = completion([{ status: "upcoming", activeMinutes: 60 }]);
    expect(result.sessionsRate).toBeNull();
    expect(result.hoursRate).toBeNull();
    expect(formatRate(result.sessionsRate)).toBe("–");
  });

  it("formats a rate as a whole percentage", () => {
    expect(formatRate(5 / 6)).toBe("83%");
  });
});

describe("longerThanPlanned", () => {
  it("is true only past 120% of the active minutes", () => {
    expect(longerThanPlanned(50, 60 * 60)).toBe(false);
    expect(longerThanPlanned(50, 61 * 60)).toBe(true);
    expect(longerThanPlanned(0, 3600)).toBe(false);
  });
});

describe("completionSummary", () => {
  const TODAY = "2026-11-29"; // a Sunday

  it("splits this week from the last 4 weeks and counts open sessions up to yesterday", () => {
    const summary = completionSummary(
      [
        { date: "2026-10-31", status: "skipped", activeMinutes: 60 }, // before the 4 weeks
        { date: "2026-11-10", status: "skipped", activeMinutes: 60 },
        { date: "2026-11-18", status: "unconfirmed", activeMinutes: 40 },
        { date: "2026-11-24", status: "done", activeMinutes: 60 },
        { date: "2026-11-26", status: "partial", activeMinutes: 40 },
        { date: "2026-11-28", status: "upcoming", activeMinutes: 30 },
        { date: TODAY, status: "done", activeMinutes: 90 },
        { date: TODAY, status: "upcoming", activeMinutes: 30 }, // later today: not open
        { date: "2026-11-27", status: "replaced", activeMinutes: 50 },
      ],
      TODAY,
    );
    expect(summary.week).toMatchObject({ counted: 3, done: 2, partial: 1, skipped: 0, open: 1 });
    expect(summary.week.sessionsRate).toBeCloseTo(2.5 / 3);
    expect(summary.recent).toMatchObject({ counted: 4, done: 2, partial: 1, skipped: 1, open: 2 });
  });
});

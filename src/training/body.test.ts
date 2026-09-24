import { describe, expect, it } from "vitest";
import {
  bodyChange,
  describeBodyChange,
  describeBodyWeek,
  latestWeight,
  wattsPerKg,
  weeklyBody,
} from "./body.js";

// Fake readings (ADR-013).
const reading = (date: string, weightKg: number | null, bodyFatPct: number | null = null) => ({
  date,
  weightKg,
  bodyFatPct,
});

describe("weeklyBody", () => {
  it("averages each Monday-Sunday week and skips weeks without readings", () => {
    const weeks = weeklyBody(
      [
        reading("2026-08-31", 71, 16),
        reading("2026-09-06", 70, 15), // Sunday, same week
        reading("2026-09-21", 69.5, null),
      ],
      "2026-08-31",
      4,
    );
    expect(weeks).toEqual([
      { weekStart: "2026-08-31", weightKg: 70.5, bodyFatPct: 15.5, readings: 2 },
      { weekStart: "2026-09-21", weightKg: 69.5, bodyFatPct: null, readings: 1 },
    ]);
    expect(describeBodyWeek(weeks[0] ?? never())).toBe(
      "Mon 2026-08-31: weight 70.5 kg, body fat 15.5% (2 readings)",
    );
  });

  it("reports the change over 4 weeks only when both weeks have data", () => {
    const weeks = weeklyBody(
      [reading("2026-08-24", 71, 16), reading("2026-09-21", 70.2, 15.4)],
      "2026-08-24",
      5,
    );
    const change = bodyChange(weeks);
    expect(change?.weightKg).toBeCloseTo(-0.8);
    expect(describeBodyChange(change ?? never())).toBe(
      "Change over 4 weeks: weight -0.8 kg, body fat -0.6 points",
    );
    expect(bodyChange(weeks.slice(1))).toBeNull();
  });
});

describe("W/kg", () => {
  it("uses the newest weight from the last 30 days", () => {
    const readings = [
      reading("2026-09-01", 71),
      reading("2026-09-20", 70),
      reading("2026-09-22", null),
    ];
    expect(latestWeight(readings, "2026-09-24")).toEqual({ weightKg: 70, date: "2026-09-20" });
    expect(latestWeight(readings, "2026-11-01")).toBeNull();
    expect(wattsPerKg(200, 70)).toBe(2.86);
  });
});

function never(): never {
  throw new Error("unexpected undefined");
}

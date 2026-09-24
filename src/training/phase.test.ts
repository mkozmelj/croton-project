import { describe, expect, it } from "vitest";
import { derivePhase, weeksAndDaysUntil } from "./phase.js";

describe("derivePhase", () => {
  const race = "2027-06-13"; // a Sunday
  it.each([
    ["2027-06-07", "race"], // race week
    ["2027-06-06", "peak"], // 7 days out
    ["2027-05-24", "peak"], // 20 days out
    ["2027-05-23", "build"], // 21 days out
    ["2027-03-29", "build"], // 76 days out: week 10 is the last build week
    ["2027-03-28", "base"],
    ["2026-10-01", "base"],
    ["2027-06-20", "transition"],
    ["2027-07-11", "transition"], // 28 days after
  ] as const)("on %s the phase is %s", (on, phase) => {
    expect(derivePhase(race, on)).toBe(phase);
  });

  it("is unknown long after the A event", () => {
    expect(derivePhase(race, "2027-07-12")).toBeNull();
  });
});

describe("weeksAndDaysUntil", () => {
  it("counts whole weeks", () => {
    expect(weeksAndDaysUntil("2026-12-20", "2026-09-24")).toEqual({ weeks: 12, days: 87 });
  });
});

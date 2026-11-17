import { describe, expect, it } from "vitest";
import { completion, formatRate, longerThanPlanned } from "./completion.js";

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

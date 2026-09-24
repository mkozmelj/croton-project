import { describe, expect, it } from "vitest";
import { addDays, localDate, localMidnight, monthStart, weekStart } from "./dates.js";

describe("localDate", () => {
  it("uses the local calendar date, not UTC", () => {
    // 22:30 UTC on 31 Aug is 00:30 on 1 Sep in Ljubljana (CEST, UTC+2).
    const instant = new Date("2026-08-31T22:30:00Z");
    expect(localDate(instant, "Europe/Ljubljana")).toBe("2026-09-01");
    expect(localDate(instant, "UTC")).toBe("2026-08-31");
  });

  it("follows the winter offset too", () => {
    // 23:30 UTC on 31 Jan is 00:30 on 1 Feb in Ljubljana (CET, UTC+1).
    expect(localDate(new Date("2027-01-31T23:30:00Z"), "Europe/Ljubljana")).toBe("2027-02-01");
  });
});

describe("monthStart", () => {
  it("returns the first day of the month", () => {
    expect(monthStart("2026-09-24")).toBe("2026-09-01");
  });
});

describe("localMidnight", () => {
  it("returns the UTC instant of local midnight in summer and winter", () => {
    expect(localMidnight("2026-09-24", "Europe/Ljubljana").toISOString()).toBe(
      "2026-09-23T22:00:00.000Z",
    );
    expect(localMidnight("2027-01-15", "Europe/Ljubljana").toISOString()).toBe(
      "2027-01-14T23:00:00.000Z",
    );
  });

  it("handles the days DST starts and ends", () => {
    expect(localMidnight("2027-03-28", "Europe/Ljubljana").toISOString()).toBe(
      "2027-03-27T23:00:00.000Z",
    );
    expect(localMidnight("2026-10-25", "Europe/Ljubljana").toISOString()).toBe(
      "2026-10-24T22:00:00.000Z",
    );
  });
});

describe("weekStart", () => {
  it("returns the Monday of the week", () => {
    expect(weekStart("2026-09-24")).toBe("2026-09-21"); // Thursday
    expect(weekStart("2026-09-21")).toBe("2026-09-21"); // Monday
    expect(weekStart("2026-09-27")).toBe("2026-09-21"); // Sunday
  });
});

describe("addDays", () => {
  it("crosses month boundaries", () => {
    expect(addDays("2026-09-28", 7)).toBe("2026-10-05");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
  });
});

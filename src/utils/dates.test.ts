import { describe, expect, it } from "vitest";
import { localDate, monthStart } from "./dates.js";

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

import { describe, expect, it } from "vitest";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import { monthlyLines, peakLines } from "./history-summary.js";

const dayOf = (a: { startedAt: Date }) => a.startedAt.toISOString().slice(0, 10);

const run = (date: string, minutes: number, km: number) =>
  storedActivity({
    startedAt: new Date(`${date}T06:00:00Z`),
    durationSeconds: minutes * 60,
    distanceMeters: km * 1000,
    elevationGainMeters: 0,
  });

describe("monthlyLines", () => {
  it("totals per sport per month, oldest first", () => {
    const lines = monthlyLines(
      [
        run("2026-02-10", 60, 10),
        run("2025-11-03", 30, 5),
        run("2026-02-12", 90, 15),
        storedActivity({
          sport: "bike",
          startedAt: new Date("2026-02-14T06:00:00Z"),
          durationSeconds: 7200,
          distanceMeters: 60_000,
          elevationGainMeters: 0,
        }),
      ],
      dayOf,
    );
    expect(lines).toEqual([
      "- 2025-11: run: 1x, 30:00, 5.00 km",
      "- 2026-02: run: 2x, 2:30:00, 25.0 km; bike: 1x, 2:00:00, 60.0 km",
    ]);
  });
});

describe("peakLines", () => {
  it("finds the biggest week and the longest session per sport", () => {
    const lines = peakLines(
      [run("2026-03-02", 50, 10), run("2026-03-04", 60, 12), run("2026-05-10", 150, 30)],
      dayOf,
    );
    expect(lines).toEqual([
      "- run: biggest week Mon 2026-05-04: 1x, 2:30:00, 30.0 km; longest session 2026-05-10: 2:30:00, 30.0 km",
    ]);
  });
});

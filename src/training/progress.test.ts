import { describe, expect, it } from "vitest";
import { lowerIsBetter, progressSpec, progressValue } from "./progress.js";
import { SESSION_TYPES } from "./session-types.js";

const source = {
  sport: "run",
  durationSeconds: 3000,
  distanceMeters: 10_000,
  avgPacePerKm: null,
  avgPower: null,
  rpe: null,
};

describe("progressSpec", () => {
  it("has a spec for every session type", () => {
    for (const type of SESSION_TYPES) expect(progressSpec(type, "run").label).not.toBe("");
  });

  it("follows the leg's sport for bricks and field tests", () => {
    expect(progressSpec("brick_aerobic", "run").metric).toBe("pace");
    expect(progressSpec("brick_aerobic", "bike").metric).toBe("power");
    expect(progressSpec("field_test", "swim").metric).toBe("swim_pace");
    expect(progressSpec("run_long", "run").metric).toBe("duration");
  });
});

describe("progressValue", () => {
  it("prefers the stored pace and derives it from distance otherwise", () => {
    expect(progressValue("pace", { ...source, avgPacePerKm: 290 })).toBe(290);
    expect(progressValue("pace", source)).toBe(300);
    expect(progressValue("pace", { ...source, distanceMeters: null })).toBeNull();
  });

  it("reads swim pace per 100 m, power, duration and RPE", () => {
    expect(progressValue("swim_pace", { ...source, sport: "swim", distanceMeters: 2000 })).toBe(
      150,
    );
    expect(progressValue("power", { ...source, avgPower: 210 })).toBe(210);
    expect(progressValue("power", source)).toBeNull();
    expect(progressValue("duration", source)).toBe(50);
    expect(progressValue("rpe", { ...source, rpe: 7 })).toBe(7);
  });

  it("marks paces as lower-is-better", () => {
    expect(lowerIsBetter("pace")).toBe(true);
    expect(lowerIsBetter("power")).toBe(false);
  });
});

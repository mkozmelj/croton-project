import { describe, expect, it } from "vitest";
import {
  describeAge,
  formatMarkerValue,
  isStale,
  latestMarkers,
  type Marker,
  missingAnchors,
} from "./markers.js";

const marker = (overrides: Partial<Marker>): Marker => ({
  sport: "bike",
  metric: "ftp_w",
  value: 250,
  measuredOn: "2026-09-01",
  source: "intervals",
  ...overrides,
});

describe("latestMarkers", () => {
  it("keeps the first (newest) row per sport and metric", () => {
    const rows = [
      marker({ value: 260, measuredOn: "2026-09-10" }),
      marker({ value: 250, measuredOn: "2026-05-01" }),
      marker({ sport: "run", metric: "vdot", value: 48 }),
    ];
    expect(latestMarkers(rows).map((m) => m.value)).toEqual([260, 48]);
  });
});

describe("isStale", () => {
  it("allows 12 weeks in base, 8 in build and peak", () => {
    expect(isStale("2026-07-02", "2026-09-24", "base")).toBe(false); // 12 weeks exactly
    expect(isStale("2026-07-01", "2026-09-24", "base")).toBe(true);
    expect(isStale("2026-07-02", "2026-09-24", "build")).toBe(true);
    expect(isStale("2026-07-30", "2026-09-24", "peak")).toBe(false); // 8 weeks exactly
    expect(isStale("2026-07-01", "2026-09-24", null)).toBe(true);
  });
});

describe("missingAnchors", () => {
  it("flags only trained sports without an intensity anchor", () => {
    const markers = [marker({ sport: "run", metric: "lthr_bpm", value: 170 })];
    expect(missingAnchors(markers, ["trail_run", "bike", "tennis"])).toEqual([
      { sport: "bike", fieldTest: "a 20-min FTP test" },
    ]);
  });

  it("does not count max HR as an anchor", () => {
    const markers = [marker({ sport: "swim", metric: "max_hr_bpm", value: 190 })];
    expect(missingAnchors(markers, ["swim"]).map((m) => m.sport)).toEqual(["swim"]);
  });
});

describe("formatting", () => {
  it("renders values with units", () => {
    expect(formatMarkerValue("threshold_pace_s_per_km", 272)).toBe("threshold pace 4:32 /km");
    expect(formatMarkerValue("css_s_per_100m", 105)).toBe("CSS 1:45 /100 m");
    expect(formatMarkerValue("vdot", 49.95)).toBe("VDOT 50.0");
  });

  it("renders ages", () => {
    expect(describeAge("2026-09-24", "2026-09-24")).toBe("today");
    expect(describeAge("2026-09-03", "2026-09-24")).toBe("3 weeks ago");
    expect(describeAge("2026-03-01", "2026-09-24")).toBe("7 months ago");
  });
});

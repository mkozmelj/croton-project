import { describe, expect, it } from "vitest";
import type { LapSummary } from "../db/schema.js";
import { markersFromFieldTest } from "./field-tests.js";

const lap = (overrides: Partial<LapSummary>): LapSummary => ({
  name: "Lap",
  elapsedSeconds: 600,
  movingSeconds: 600,
  distanceMeters: 2000,
  avgHr: 140,
  avgWatts: null,
  ...overrides,
});

const activity = (sport: string, laps: LapSummary[]) => ({
  externalId: "123",
  sport,
  startedOn: "2026-09-24",
  laps,
});

describe("markersFromFieldTest", () => {
  it("bike: FTP is 95% of the 20-min lap's power, LTHR its HR", () => {
    const markers = markersFromFieldTest(
      "bike_ftp_20min",
      activity("bike", [
        lap({ avgWatts: 150 }),
        lap({ movingSeconds: 1200, avgWatts: 260, avgHr: 168 }),
      ]),
    );
    expect(markers.map((m) => [m.metric, m.value])).toEqual([
      ["ftp_w", 247],
      ["lthr_bpm", 168],
    ]);
    expect(markers[0]).toMatchObject({
      source: "field_test",
      sourceRef: "123",
      measuredOn: "2026-09-24",
    });
  });

  it("run: LTHR and threshold pace from the last 20 min", () => {
    const markers = markersFromFieldTest(
      "run_lthr_30min",
      activity("run", [lap({}), lap({ movingSeconds: 1200, distanceMeters: 4444, avgHr: 171 })]),
    );
    expect(markers.map((m) => [m.metric, m.value])).toEqual([
      ["lthr_bpm", 171],
      ["threshold_pace_s_per_km", 270],
    ]);
  });

  it("swim: CSS from the 400 m and 200 m trials", () => {
    const markers = markersFromFieldTest(
      "swim_css",
      activity("swim", [
        lap({ distanceMeters: 400, elapsedSeconds: 380 }),
        lap({ distanceMeters: 200, elapsedSeconds: 170 }),
      ]),
    );
    expect(markers.map((m) => [m.metric, m.value])).toEqual([["css_s_per_100m", 105]]);
  });

  it("proposes nothing without a matching lap or for the wrong sport", () => {
    expect(
      markersFromFieldTest("bike_ftp_20min", activity("bike", [lap({ avgWatts: 200 })])),
    ).toEqual([]);
    expect(markersFromFieldTest("swim_css", activity("run", []))).toEqual([]);
  });
});

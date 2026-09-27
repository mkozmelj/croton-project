import { describe, expect, it } from "vitest";
import type { LapSummary } from "../db/schema.js";
import { type BreakthroughActivity, breakthroughMarkers } from "./breakthroughs.js";
import type { Marker } from "./markers.js";

const marker = (m: Pick<Marker, "sport" | "metric" | "value">): Marker => ({
  ...m,
  measuredOn: "2026-08-01",
  source: "intervals",
});

const CURRENT: Marker[] = [
  marker({ sport: "bike", metric: "ftp_w", value: 250 }),
  marker({ sport: "run", metric: "vdot", value: 45 }),
  marker({ sport: "run", metric: "threshold_pace_s_per_km", value: 270 }),
];

const lap = (overrides: Partial<LapSummary>): LapSummary => ({
  name: "Lap 2",
  elapsedSeconds: 1200,
  movingSeconds: 1200,
  distanceMeters: 0,
  avgHr: 160,
  avgWatts: null,
  ...overrides,
});

const ride = (overrides: Partial<BreakthroughActivity> = {}): BreakthroughActivity => ({
  externalId: "900",
  name: "Hill reps",
  sport: "bike",
  startedOn: "2026-09-26",
  movingSeconds: 5400,
  distanceMeters: 45_000,
  avgWatts: 190,
  measuredPower: true,
  indoor: false,
  laps: null,
  ...overrides,
});

const run = (overrides: Partial<BreakthroughActivity> = {}): BreakthroughActivity =>
  ride({ name: "Parkrun", sport: "run", avgWatts: null, measuredPower: false, ...overrides });

describe("breakthroughMarkers: bike", () => {
  it("proposes FTP from a 20+ min lap well above the current FTP", () => {
    // 95% of 280 W = 266 W, 6% above 250 W.
    const [ftp] = breakthroughMarkers(
      ride({ laps: [lap({ movingSeconds: 1260, avgWatts: 280 })] }),
      CURRENT,
    );
    expect(ftp).toMatchObject({
      sport: "bike",
      metric: "ftp_w",
      value: 266,
      source: "activity",
      sourceRef: "900",
      measuredOn: "2026-09-26",
    });
    expect(ftp?.notes).toContain("was 250 W");
  });

  it("ignores efforts a correct FTP already predicts (105% for 20 min)", () => {
    const laps = [lap({ avgWatts: 263 })]; // 95% = 250 W
    expect(breakthroughMarkers(ride({ laps }), CURRENT)).toEqual([]);
  });

  it("ignores short laps and estimated power", () => {
    const short = [lap({ movingSeconds: 600, avgWatts: 330 })];
    expect(breakthroughMarkers(ride({ laps: short }), CURRENT)).toEqual([]);
    const strong = [lap({ avgWatts: 300 })];
    expect(breakthroughMarkers(ride({ laps: strong, measuredPower: false }), CURRENT)).toEqual([]);
  });

  it("uses the whole ride's plain average when there are no laps", () => {
    const [ftp] = breakthroughMarkers(ride({ movingSeconds: 2400, avgWatts: 285 }), CURRENT);
    expect(ftp?.value).toBe(271);
  });

  it("needs a current FTP to compare with", () => {
    const laps = [lap({ avgWatts: 300 })];
    expect(breakthroughMarkers(ride({ laps }), [])).toEqual([]);
  });
});

describe("breakthroughMarkers: run", () => {
  it("proposes VDOT from a run faster than the current VDOT predicts", () => {
    // 5 km in 20:00 is VDOT ~49.8, well above 45.
    const [vdot] = breakthroughMarkers(run({ movingSeconds: 1200, distanceMeters: 5000 }), CURRENT);
    expect(vdot).toMatchObject({ sport: "run", metric: "vdot", source: "activity" });
    expect(vdot?.value).toBeGreaterThan(49);
    expect(vdot?.value).toBeLessThan(50.5);
  });

  it("checks laps too, and proposes threshold pace from a 20+ min lap", () => {
    // A 25-min lap at 4:10/km (250 s), 7% faster than the 4:30 threshold pace.
    const laps = [lap({ movingSeconds: 1500, distanceMeters: 6000 })];
    const markers = breakthroughMarkers(
      run({ movingSeconds: 3600, distanceMeters: 11_000, laps }),
      CURRENT,
    );
    expect(markers.map((m) => m.metric)).toEqual(["vdot", "threshold_pace_s_per_km"]);
    expect(markers[1]).toMatchObject({ value: 250 });
    expect(markers[1]?.notes).toContain('lap "Lap 2"');
  });

  it("ignores easy runs, trail and treadmill runs, and implausible jumps", () => {
    const easy = run({ movingSeconds: 3600, distanceMeters: 10_000 });
    expect(breakthroughMarkers(easy, CURRENT)).toEqual([]);
    const trail = run({ sport: "trail_run", movingSeconds: 1200, distanceMeters: 5000 });
    expect(breakthroughMarkers(trail, CURRENT)).toEqual([]);
    const treadmill = run({ indoor: true, movingSeconds: 1200, distanceMeters: 5000 });
    expect(breakthroughMarkers(treadmill, CURRENT)).toEqual([]);
    // 10 km in 25 min: a ride tagged as a run, not VDOT 80.
    const glitch = run({ movingSeconds: 1500, distanceMeters: 10_000 });
    expect(breakthroughMarkers(glitch, CURRENT)).toEqual([]);
  });
});

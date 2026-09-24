import { describe, expect, it } from "vitest";
import type { Marker } from "./markers.js";
import {
  cogganPowerZones,
  cssSwimZones,
  deriveZones,
  describeZoneSet,
  frielHrZones,
  frielRunPaceZones,
  intervalsZonesOf,
  type ZoneSet,
} from "./zones.js";

const marker = (overrides: Partial<Marker>): Marker => ({
  sport: "bike",
  metric: "ftp_w",
  value: 250,
  measuredOn: "2026-09-01",
  source: "athlete_reported",
  ...overrides,
});

describe("computed zones", () => {
  it("Coggan power levels from FTP", () => {
    const { zones } = cogganPowerZones(200);
    expect(zones[0]).toEqual({ name: "Z1 Active Recovery", from: null, to: 110 });
    expect(zones[3]).toEqual({ name: "Z4 Threshold", from: 180, to: 210 });
    expect(zones[6]).toEqual({ name: "Z7 Neuromuscular", from: 300, to: null });
  });

  it("Friel HR zones differ for running and cycling", () => {
    expect(frielHrZones(170, "run").zones[1]).toMatchObject({ from: 145, to: 153 });
    expect(frielHrZones(170, "bike").zones[1]).toMatchObject({ from: 138, to: 153 });
  });

  it("Friel run pace zones run from slow to fast", () => {
    const { zones } = frielRunPaceZones(300); // 5:00 /km threshold
    expect(zones[3]).toEqual({ name: "Z4 SubThreshold", from: 318, to: 297 });
  });

  it("CSS offsets", () => {
    expect(cssSwimZones(110).zones[3]).toEqual({ name: "Z4 Threshold (CSS)", from: 113, to: 108 });
  });

  it("renders a zone set as one line", () => {
    expect(describeZoneSet("swim", "pace", cssSwimZones(110))).toBe(
      "swim pace (CSS offsets): Z1 Recovery slower than 2:05, Z2 Endurance 2:05-1:58, Z3 Tempo 1:58-1:53, Z4 Threshold (CSS) 1:53-1:48, Z5 VO2max faster than 1:48 /100 m",
    );
  });
});

describe("deriveZones", () => {
  const intervalsHr: ZoneSet = {
    unit: "bpm",
    source: "intervals",
    method: "Intervals.icu",
    basis: { metric: "lthr_bpm", value: 170 },
    zones: [{ name: "Z1", from: null, to: 140 }],
  };

  it("uses Intervals.icu zones while they match the current marker", () => {
    const zones = deriveZones([marker({ metric: "lthr_bpm", value: 170 })], {
      bike: { hr: intervalsHr },
    });
    expect(zones.bike?.hr).toBe(intervalsHr);
  });

  it("computes zones when the marker moved on (e.g. a newer field test)", () => {
    const zones = deriveZones([marker({ metric: "lthr_bpm", value: 175 })], {
      bike: { hr: intervalsHr },
    });
    expect(zones.bike?.hr?.source).toBe("computed");
    expect(zones.bike?.hr?.basis.value).toBe(175);
  });

  it("prefers the newer of VDOT and threshold pace for run pace", () => {
    const vdot = marker({ sport: "run", metric: "vdot", value: 50, measuredOn: "2026-06-01" });
    const pace = marker({
      sport: "run",
      metric: "threshold_pace_s_per_km",
      value: 270,
      measuredOn: "2026-09-01",
    });
    expect(deriveZones([vdot, pace], {}).run?.pace?.basis.metric).toBe("threshold_pace_s_per_km");
    expect(
      deriveZones([{ ...vdot, measuredOn: "2026-09-10" }, pace], {}).run?.pace?.basis.metric,
    ).toBe("vdot");
  });

  it("keeps only Intervals.icu sets when re-deriving from a snapshot", () => {
    const snapshot = { bike: { hr: intervalsHr, power: cogganPowerZones(250) } };
    expect(intervalsZonesOf(snapshot)).toEqual({ bike: { hr: intervalsHr } });
  });
});

import { describe, expect, it } from "vitest";
import { athleteSchema } from "./client.js";
import { markersFromIntervals, zonesFromIntervals } from "./profile-mapper.js";
import { intervalsAthlete } from "./test-fixtures.js";

const athlete = athleteSchema.parse(intervalsAthlete());

describe("markersFromIntervals", () => {
  it("maps thresholds with the verified units", () => {
    const markers = markersFromIntervals(athlete, "2026-09-24");
    const values = Object.fromEntries(markers.map((m) => [`${m.sport}:${m.metric}`, m.value]));
    expect(values).toEqual({
      "bike:ftp_w": 250,
      "bike:lthr_bpm": 170,
      "run:lthr_bpm": 172,
      "run:threshold_pace_s_per_km": 270, // 3.7037 m/s = 4:30 /km
      "swim:lthr_bpm": 172,
      "swim:css_s_per_100m": 120, // 0.8333 m/s = 2:00 /100 m
      "all:max_hr_bpm": 190,
    });
    expect(markers.every((m) => m.source === "intervals" && m.measuredOn === "2026-09-24")).toBe(
      true,
    );
  });

  it("keeps max HR per sport when they differ", () => {
    const raw = intervalsAthlete();
    const [bike] = raw.sportSettings;
    if (bike) bike.max_hr = 185;
    const markers = markersFromIntervals(athleteSchema.parse(raw), "2026-09-24");
    expect(markers.filter((m) => m.metric === "max_hr_bpm").map((m) => [m.sport, m.value])).toEqual(
      [
        ["bike", 185],
        ["run", 190],
        ["swim", 190],
      ],
    );
  });
});

describe("zonesFromIntervals", () => {
  const zones = zonesFromIntervals(athlete);

  it("turns % of FTP upper bounds into watts, the last one open", () => {
    expect(zones.bike?.power?.basis).toEqual({ metric: "ftp_w", value: 250 });
    expect(zones.bike?.power?.zones[0]).toEqual({
      name: "Z1 Active Recovery",
      from: null,
      to: 138,
    });
    expect(zones.bike?.power?.zones[3]).toEqual({ name: "Z4 Threshold", from: 225, to: 263 });
    expect(zones.bike?.power?.zones[6]).toEqual({ name: "Z7 Neuromuscular", from: 375, to: null });
  });

  it("takes absolute HR upper bounds, based on the sport's LTHR", () => {
    expect(zones.run?.hr?.basis).toEqual({ metric: "lthr_bpm", value: 172 });
    expect(zones.run?.hr?.zones[1]).toEqual({ name: "Z2 Aerobic", from: 145, to: 153 });
    expect(zones.swim?.hr?.zones[0]?.name).toBe("Z1");
  });

  it("never reads pace zones", () => {
    expect(zones.run?.pace).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { parseProfileEdit } from "./profile-edit.js";

const TODAY = "2026-09-27";

const markerOf = (args: string) => {
  const edit = parseProfileEdit(args, TODAY);
  if (!edit.ok || edit.actionType !== "add_fitness_marker") throw new Error(JSON.stringify(edit));
  return edit.payload.markers[0];
};

describe("parseProfileEdit", () => {
  it.each([
    ["ftp 250", { sport: "bike", metric: "ftp_w", value: 250 }],
    ["lthr run 168", { sport: "run", metric: "lthr_bpm", value: 168 }],
    ["LTHR Bike 160", { sport: "bike", metric: "lthr_bpm", value: 160 }],
    ["maxhr 190", { sport: "all", metric: "max_hr_bpm", value: 190 }],
    ["maxhr run 192", { sport: "run", metric: "max_hr_bpm", value: 192 }],
    ["pace 4:15", { sport: "run", metric: "threshold_pace_s_per_km", value: 255 }],
    ["css 1:45", { sport: "swim", metric: "css_s_per_100m", value: 105 }],
    ["vdot 48.5", { sport: "run", metric: "vdot", value: 48.5 }],
  ])("proposes a marker for %s", (args, expected) => {
    expect(markerOf(args)).toMatchObject({
      ...expected,
      measuredOn: TODAY,
      source: "athlete_reported",
    });
  });

  it("computes VDOT from a race in code", () => {
    // Daniels' table: a 40:00 10K is VDOT ~51.9.
    const marker = markerOf("vdot 10k 40:00");
    expect(marker?.value).toBeGreaterThan(51.5);
    expect(marker?.value).toBeLessThan(52.3);
    expect(marker?.notes).toBe("from 10k in 40:00");
    expect(markerOf("vdot half 1:30:00")?.value).toBeGreaterThan(50);
  });

  it("takes a trailing date as the measurement day", () => {
    expect(markerOf("ftp 250 2026-09-20")?.measuredOn).toBe("2026-09-20");
    expect(parseProfileEdit("ftp 250 2026-10-01", TODAY)).toMatchObject({ ok: false });
  });

  it.each([
    "ftp 2500",
    "ftp abc",
    "lthr 168",
    "pace 415",
    "css 7:00",
    "vdot 100m 0:12",
    "vdot 10k fast",
    "zones 1",
    "",
  ])("rejects %j", (args) => {
    const edit = parseProfileEdit(args, TODAY);
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error).not.toBe("");
  });

  it("proposes profile field changes, leaving the others unchanged", () => {
    expect(parseProfileEdit("availability Mon rest, long ride Sat", TODAY)).toEqual({
      ok: true,
      actionType: "update_profile",
      payload: {
        name: null,
        background: null,
        availability: "Mon rest, long ride Sat",
        injuryNotes: null,
        raceMarkers: [],
      },
    });
    expect(parseProfileEdit("injuries none", TODAY)).toMatchObject({
      payload: { injuryNotes: "none" },
    });
    expect(parseProfileEdit("name Alex", TODAY)).toMatchObject({ payload: { name: "Alex" } });
    expect(parseProfileEdit("availability", TODAY).ok).toBe(false);
  });
});

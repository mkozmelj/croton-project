import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";
import {
  activitiesFromWorkouts,
  externalIdFor,
  planMarkdown,
  sportFromTrainingPeaks,
  withoutStravaDuplicates,
} from "./mapper.js";
import { parseWorkoutsCsv, TrainingPeaksCsvError } from "./workouts.js";

const HEADER =
  "Title,WorkoutType,WorkoutDescription,PlannedDuration,PlannedDistanceInMeters,WorkoutDay,CoachComments,DistanceInMeters,PowerAverage,HeartRateAverage,HeartRateMax,TimeTotalInHours,TSS,IF,HRZone1Minutes,HRZone2Minutes,AthleteComments,Feeling";
const csv = [
  HEADER,
  'Long ride,Bike,"Z2 steady, 3h\nfuel 60 g/h",3,90000,2024-05-11,,88500,180,138,160,2.95,160,0.7,20,150,Felt good,4',
  "Brick,Run,15 min off the bike,0.25,,2024-05-11,,3100,,150,165,0.26,20,0.85,,,,",
  "Rest,Day Off,,,,2024-05-13,,,,,,,,,,,,",
  "Tempo run,Run,3x10 min T,1,,2024-05-14,,,,,,,,,,,,",
].join("\r\n");

describe("parseCsv", () => {
  it("handles quotes, commas, doubled quotes, line breaks and a BOM", () => {
    expect(parseCsv('﻿a,b\n"x, ""y""","line1\nline2"\n')).toEqual([
      ["a", "b"],
      ['x, "y"', "line1\nline2"],
    ]);
  });
});

describe("parseWorkoutsCsv", () => {
  it("reads planned and completed fields and reports unknown columns", () => {
    const { workouts, ignoredColumns } = parseWorkoutsCsv(csv);
    expect(workouts).toHaveLength(4);
    expect(workouts[0]).toMatchObject({
      day: "2024-05-11",
      type: "Bike",
      description: "Z2 steady, 3h\nfuel 60 g/h",
      plannedHours: 3,
      hours: 2.95,
      distanceMeters: 88500,
      avgHr: 138,
      tss: 160,
      hrZoneMinutes: { z1: 20, z2: 150 },
    });
    expect(workouts[3]?.hours).toBeNull();
    expect(ignoredColumns).toEqual(["Feeling"]);
  });

  it("rejects a file that isn't a workouts export", () => {
    expect(() => parseWorkoutsCsv("Date,Value\n2024-01-01,3")).toThrow(TrainingPeaksCsvError);
  });
});

describe("activitiesFromWorkouts", () => {
  it("imports completed workouts only, at local noon, with stable ids", () => {
    const { workouts } = parseWorkoutsCsv(csv);
    const rows = activitiesFromWorkouts(workouts, "Europe/Ljubljana");
    expect(rows.map((r) => [r.sport, r.name])).toEqual([
      ["bike", "Long ride"],
      ["run", "Brick"],
    ]);
    expect(rows[0]).toMatchObject({
      source: "trainingpeaks_import",
      durationSeconds: 10620,
      trainingLoad: 160,
      notes: "Felt good",
      startedAt: new Date("2024-05-11T10:00:00Z"),
    });
    expect(rows[1]?.avgPacePerKm).toBeCloseTo(302, 0);
    // Same file → same ids, so a re-import updates instead of duplicating.
    expect(activitiesFromWorkouts(workouts, "Europe/Ljubljana").map((r) => r.externalId)).toEqual(
      rows.map((r) => r.externalId),
    );
  });

  it("tells identical workouts on one day apart", () => {
    const [w] = parseWorkoutsCsv(csv).workouts;
    if (!w) throw new Error("no workout");
    expect(externalIdFor(w, 0)).not.toBe(externalIdFor(w, 1));
  });
});

describe("withoutStravaDuplicates", () => {
  it("skips a workout Strava already has on the same day, sport and similar duration", () => {
    const rows = activitiesFromWorkouts(parseWorkoutsCsv(csv).workouts, "Europe/Ljubljana");
    const strava = (sport: string, iso: string, durationSeconds: number) => ({
      source: "strava" as const,
      sport,
      startedAt: new Date(iso),
      durationSeconds,
    });
    const { kept, skipped } = withoutStravaDuplicates(
      rows,
      [
        strava("bike", "2024-05-11T06:30:00Z", 10_400), // same ride, recorded by Strava
        strava("run", "2024-05-12T06:30:00Z", 940), // next day: not a duplicate
      ],
      "Europe/Ljubljana",
    );
    expect(skipped.map((r) => r.name)).toEqual(["Long ride"]);
    expect(kept.map((r) => r.name)).toEqual(["Brick"]);
  });

  it("keeps workouts when only other imports or different sessions exist", () => {
    const rows = activitiesFromWorkouts(parseWorkoutsCsv(csv).workouts, "Europe/Ljubljana");
    const { kept } = withoutStravaDuplicates(
      rows,
      [
        {
          source: "trainingpeaks_import",
          sport: "bike",
          startedAt: new Date("2024-05-11T10:00:00Z"),
          durationSeconds: 10_620,
        },
        {
          source: "strava",
          sport: "bike",
          startedAt: new Date("2024-05-11T16:00:00Z"),
          durationSeconds: 1_800,
        },
      ],
      "Europe/Ljubljana",
    );
    expect(kept).toHaveLength(2);
  });
});

describe("sportFromTrainingPeaks", () => {
  it.each([
    ["Bike", "Long ride", "bike"],
    ["MTB", "Mountain Biking", "bike"],
    ["Other", "Tennis", "tennis"],
    ["Walk", "Hiking", "hike"],
    ["Brick", "Road Cycling", "bike"],
    ["Brick", "Bike + run", "brick"],
    ["Other", "Kronplatz", "other"],
    ["Run", "Tennis warm-up jog", "run"],
  ])("%s / %s → %s", (type, title, sport) => {
    expect(sportFromTrainingPeaks(type, title)).toBe(sport);
  });
});

describe("planMarkdown", () => {
  it("groups the plan by week with planned and done details", () => {
    const text = planMarkdown(parseWorkoutsCsv(csv).workouts, "TP 2024");
    expect(text).toContain("## Week of 2024-05-06 to 2024-05-12");
    expect(text).toContain("Completed 2 of 2 sessions, 3:13 h, TSS 180.");
    expect(text).toContain(
      "- Sat 2024-05-11 Bike: Long ride (planned 3:00, done 2:57 / 88.5 km, avg HR 138, TSS 160)",
    );
    expect(text).toContain("  Plan: Z2 steady, 3h fuel 60 g/h");
    expect(text).toContain("- Tue 2024-05-14 Run: Tempo run (planned 1:00, not done)");
    expect(text).not.toContain("Day Off");
  });
});

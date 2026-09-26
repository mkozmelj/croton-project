import { parseCsv } from "./csv.js";

// The TrainingPeaks workout summary export (spec.md §7.4): one row per planned and/or completed
// workout. TrainingPeaks doesn't publish the column list, so columns are matched by normalized
// name and unknown ones are reported, not fatal; only the day and a title or type are required.

export class TrainingPeaksCsvError extends Error {
  override readonly name = "TrainingPeaksCsvError";
}

export type TpWorkout = {
  day: string; // YYYY-MM-DD, local
  type: string | null;
  title: string | null;
  description: string | null;
  plannedHours: number | null;
  plannedDistanceMeters: number | null;
  hours: number | null; // completed duration; null for a planned-only workout
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  tss: number | null;
  intensityFactor: number | null;
  rpe: number | null;
  coachComments: string | null;
  athleteComments: string | null;
  hrZoneMinutes: Record<string, number>;
  raw: Record<string, string>;
};

const key = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

// Normalized header → field. Aliases cover spellings seen in different export versions.
const TEXT_COLUMNS = {
  workoutday: "day",
  title: "title",
  workouttype: "type",
  workoutdescription: "description",
  coachcomments: "coachComments",
  athletecomments: "athleteComments",
} as const;

const NUMBER_COLUMNS = {
  plannedduration: "plannedHours",
  planneddistanceinmeters: "plannedDistanceMeters",
  timetotalinhours: "hours",
  distanceinmeters: "distanceMeters",
  elevationgain: "elevationGainMeters",
  elevationgaininmeters: "elevationGainMeters",
  heartrateaverage: "avgHr",
  heartratemax: "maxHr",
  poweraverage: "avgPower",
  tss: "tss",
  if: "intensityFactor",
  rpe: "rpe",
} as const;

const HR_ZONE = /^hrzone(\d+)minutes$/;

export type ParsedExport = { workouts: TpWorkout[]; ignoredColumns: string[] };

export function parseWorkoutsCsv(text: string): ParsedExport {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new TrainingPeaksCsvError("The file is empty.");
  const keys = header.map(key);
  if (!keys.includes("workoutday") || !(keys.includes("title") || keys.includes("workouttype"))) {
    throw new TrainingPeaksCsvError(
      `Not a TrainingPeaks workouts export: expected WorkoutDay and Title/WorkoutType columns, found ${header.join(", ")}`,
    );
  }
  const ignoredColumns = header.filter((_, i) => {
    const k = keys[i] ?? "";
    return !(k in TEXT_COLUMNS) && !(k in NUMBER_COLUMNS) && !HR_ZONE.test(k);
  });

  const workouts = rows.flatMap((cells, rowIndex) => {
    const raw = Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""]));
    const workout: TpWorkout = {
      day: "",
      type: null,
      title: null,
      description: null,
      plannedHours: null,
      plannedDistanceMeters: null,
      hours: null,
      distanceMeters: null,
      elevationGainMeters: null,
      avgHr: null,
      maxHr: null,
      avgPower: null,
      tss: null,
      intensityFactor: null,
      rpe: null,
      coachComments: null,
      athleteComments: null,
      hrZoneMinutes: {},
      raw,
    };
    keys.forEach((k, i) => {
      const value = (cells[i] ?? "").trim();
      if (!value) return;
      if (k in TEXT_COLUMNS) {
        workout[TEXT_COLUMNS[k as keyof typeof TEXT_COLUMNS]] = value;
        return;
      }
      const number = Number(value.replace(",", "."));
      if (!Number.isFinite(number)) return;
      if (k in NUMBER_COLUMNS) workout[NUMBER_COLUMNS[k as keyof typeof NUMBER_COLUMNS]] = number;
      const zone = k.match(HR_ZONE);
      if (zone && number > 0) workout.hrZoneMinutes[`z${zone[1]}`] = number;
    });
    const day = normalizeDay(workout.day);
    if (!day) {
      if (workout.day) {
        throw new TrainingPeaksCsvError(
          `Row ${rowIndex + 2}: unreadable WorkoutDay "${workout.day}"`,
        );
      }
      return [];
    }
    return [{ ...workout, day }];
  });
  return { workouts, ignoredColumns };
}

// "2024-05-07", "2024-05-07T00:00:00" or "2024/05/07" → "2024-05-07".
function normalizeDay(value: string): string | null {
  const match = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m?.padStart(2, "0")}-${d?.padStart(2, "0")}`;
}

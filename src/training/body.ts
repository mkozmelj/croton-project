import { addDays } from "../utils/dates.js";

// Body composition is read as a weekly trend (static prompt: "track weekly trends, not daily
// fluctuations"): one scale reading swings by a kilo with water and glycogen.

export type BodyReading = { date: string; weightKg: number | null; bodyFatPct: number | null };

export type BodyWeek = {
  weekStart: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  readings: number;
};

// A weight older than this isn't used for W/kg.
export const WEIGHT_MAX_AGE_DAYS = 30;

const average = (values: number[]) =>
  values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;

// Weekly averages for the `weeks` weeks starting at the Monday `from`; weeks without a
// reading are left out.
export function weeklyBody(
  readings: readonly BodyReading[],
  from: string,
  weeks: number,
): BodyWeek[] {
  const result: BodyWeek[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = addDays(from, 7 * i);
    const end = addDays(start, 7);
    const inWeek = readings.filter((r) => r.date >= start && r.date < end);
    const weights = inWeek.flatMap((r) => (r.weightKg != null ? [r.weightKg] : []));
    const fats = inWeek.flatMap((r) => (r.bodyFatPct != null ? [r.bodyFatPct] : []));
    if (weights.length === 0 && fats.length === 0) continue;
    result.push({
      weekStart: start,
      weightKg: average(weights),
      bodyFatPct: average(fats),
      readings: Math.max(weights.length, fats.length),
    });
  }
  return result;
}

// Change from the week `span` weeks before the latest week with data to that latest week.
export function bodyChange(
  weeks: readonly BodyWeek[],
  span = 4,
): { weeks: number; weightKg: number | null; bodyFatPct: number | null } | null {
  const latest = weeks.at(-1);
  if (!latest) return null;
  const earlier = weeks.find((w) => w.weekStart === addDays(latest.weekStart, -7 * span));
  if (!earlier) return null;
  const diff = (a: number | null, b: number | null) => (a != null && b != null ? a - b : null);
  return {
    weeks: span,
    weightKg: diff(latest.weightKg, earlier.weightKg),
    bodyFatPct: diff(latest.bodyFatPct, earlier.bodyFatPct),
  };
}

// The newest weight reading no older than WEIGHT_MAX_AGE_DAYS before `today`.
export function latestWeight(
  readings: readonly BodyReading[],
  today: string,
): { weightKg: number; date: string } | null {
  const oldest = addDays(today, -WEIGHT_MAX_AGE_DAYS);
  const reading = [...readings]
    .filter((r) => r.weightKg != null && r.date >= oldest && r.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return reading?.weightKg != null ? { weightKg: reading.weightKg, date: reading.date } : null;
}

export function wattsPerKg(watts: number, weightKg: number): number {
  return Math.round((watts / weightKg) * 100) / 100;
}

const signed = (value: number, digits: number) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

export function describeBodyWeek(week: BodyWeek): string {
  const parts: string[] = [];
  if (week.weightKg != null) parts.push(`weight ${week.weightKg.toFixed(1)} kg`);
  if (week.bodyFatPct != null) parts.push(`body fat ${week.bodyFatPct.toFixed(1)}%`);
  const readings = `${week.readings} reading${week.readings === 1 ? "" : "s"}`;
  return `Mon ${week.weekStart}: ${parts.join(", ")} (${readings})`;
}

export function describeBodyChange(change: NonNullable<ReturnType<typeof bodyChange>>): string {
  const parts: string[] = [];
  if (change.weightKg != null) parts.push(`weight ${signed(change.weightKg, 1)} kg`);
  if (change.bodyFatPct != null) parts.push(`body fat ${signed(change.bodyFatPct, 1)} points`);
  return `Change over ${change.weeks} weeks: ${parts.length > 0 ? parts.join(", ") : "n/a"}`;
}

// Daniels–Gilbert oxygen-cost and drop-off equations (Daniels & Gilbert 1979, the basis of
// the VDOT tables in Daniels' Running Formula). All arithmetic stays in code, never in the
// model (ADR-016).

// VO2 (ml/kg/min) needed to run at `metersPerMinute`.
function oxygenCost(metersPerMinute: number): number {
  return -4.6 + 0.182258 * metersPerMinute + 0.000104 * metersPerMinute ** 2;
}

// Fraction of VO2max sustainable for a race lasting `minutes`.
function sustainableFraction(minutes: number): number {
  return (
    0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes)
  );
}

// VDOT from a race result. Valid roughly from 1500 m to the marathon.
export function vdotFromRace(distanceMeters: number, timeSeconds: number): number {
  if (distanceMeters <= 0 || timeSeconds <= 0)
    throw new RangeError("distance and time must be > 0");
  const minutes = timeSeconds / 60;
  return oxygenCost(distanceMeters / minutes) / sustainableFraction(minutes);
}

// Race distances VDOT is meaningful for (flat road/track races).
export const VDOT_MIN_DISTANCE_M = 1500;
export const VDOT_MAX_DISTANCE_M = 42_195;

// Speed (m/min) at which the oxygen cost equals `vo2`: the positive root of the cost equation.
function speedForOxygenCost(vo2: number): number {
  const a = 0.000104;
  const b = 0.182258;
  const c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

// Pace (s/km) at `fraction` of VDOT.
export function paceAtFraction(vdot: number, fraction: number): number {
  return 60_000 / speedForOxygenCost(vdot * fraction);
}

// Daniels' training intensities as fractions of VDOT, fitted to the published pace tables
// (VDOT 50: E 5:07-5:38, M 4:31, T 4:15, I 3:55, R ~3:36 per km).
export const DANIELS_INTENSITIES = {
  E: [0.62, 0.7],
  M: [0.815, 0.815],
  T: [0.88, 0.88],
  I: [0.975, 0.975],
  R: [1.08, 1.08],
} as const satisfies Record<string, readonly [number, number]>;

export type DanielsPace = keyof typeof DANIELS_INTENSITIES;

// Pace range per Daniels intensity, [slow, fast] in s/km.
export function danielsPaces(vdot: number): Record<DanielsPace, [slow: number, fast: number]> {
  const entries = Object.entries(DANIELS_INTENSITIES).map(([name, [low, high]]) => [
    name,
    [paceAtFraction(vdot, low), paceAtFraction(vdot, high)],
  ]);
  return Object.fromEntries(entries) as Record<DanielsPace, [number, number]>;
}

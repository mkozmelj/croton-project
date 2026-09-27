import type { Phase } from "./phase.js";

// ADR-016: the threshold values a plan can be anchored on. Pure definitions and rules only;
// storage is src/db/fitness-markers.ts.

export const MARKER_SPORTS = ["run", "bike", "swim", "all"] as const;
export const MARKER_METRICS = [
  "ftp_w",
  "lthr_bpm",
  "max_hr_bpm",
  "threshold_pace_s_per_km",
  "css_s_per_100m",
  "vdot",
] as const;
// `activity`: a workout that clearly beat the current value (breakthroughs.ts).
export const MARKER_SOURCES = [
  "intervals",
  "field_test",
  "race",
  "athlete_reported",
  "activity",
] as const;

export type MarkerSport = (typeof MARKER_SPORTS)[number];
export type MarkerMetric = (typeof MARKER_METRICS)[number];
export type MarkerSource = (typeof MARKER_SOURCES)[number];

export type Marker = {
  sport: MarkerSport;
  metric: MarkerMetric;
  value: number;
  measuredOn: string;
  source: MarkerSource;
  sourceRef?: string | null;
  notes?: string | null;
};

// Which metrics make sense for which sport (a CSS for cycling is a typo, not a marker).
export const METRICS_BY_SPORT: Record<MarkerSport, readonly MarkerMetric[]> = {
  run: ["vdot", "threshold_pace_s_per_km", "lthr_bpm", "max_hr_bpm"],
  bike: ["ftp_w", "lthr_bpm", "max_hr_bpm"],
  swim: ["css_s_per_100m", "lthr_bpm", "max_hr_bpm"],
  all: ["max_hr_bpm"],
};

// At least one of these per sport, or the plan falls back to RPE (ADR-016).
export const INTENSITY_ANCHORS: Record<"run" | "bike" | "swim", readonly MarkerMetric[]> = {
  run: ["vdot", "threshold_pace_s_per_km", "lthr_bpm"],
  bike: ["ftp_w", "lthr_bpm"],
  swim: ["css_s_per_100m"],
};

const FIELD_TESTS: Record<"run" | "bike" | "swim", string> = {
  run: "a 30-min run threshold test",
  bike: "a 20-min FTP test",
  swim: "a CSS test (400 m + 200 m)",
};

// Activity sports (Strava-mapped, see strava/mapper.ts) → the marker sport they're coached by.
export function markerSportOf(activitySport: string): "run" | "bike" | "swim" | null {
  if (activitySport === "run" || activitySport === "trail_run") return "run";
  if (activitySport === "bike") return "bike";
  if (activitySport === "swim") return "swim";
  return null;
}

const key = (sport: string, metric: string) => `${sport}:${metric}`;

// The current value per (sport, metric): latest `measuredOn`, then the latest-written row.
// Input is expected newest first (as the store returns it).
export function latestMarkers<T extends Marker>(newestFirst: readonly T[]): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];
  for (const marker of newestFirst) {
    const k = key(marker.sport, marker.metric);
    if (seen.has(k)) continue;
    seen.add(k);
    latest.push(marker);
  }
  return latest;
}

export function findMarker<T extends Marker>(
  markers: readonly T[],
  sport: MarkerSport,
  metric: MarkerMetric,
): T | undefined {
  return markers.find((m) => m.sport === sport && m.metric === metric);
}

// Max HR recorded for 'all' applies to every sport without its own value.
export function maxHrFor(markers: readonly Marker[], sport: MarkerSport): Marker | undefined {
  return findMarker(markers, sport, "max_hr_bpm") ?? findMarker(markers, "all", "max_hr_bpm");
}

const DAY_MS = 86_400_000;

export function ageInDays(measuredOn: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(measuredOn)) / DAY_MS);
}

// ADR-016: stale after 12 weeks, or 8 in the build and peak phases.
export function staleAfterWeeks(phase: Phase | null): number {
  return phase === "build" || phase === "peak" ? 8 : 12;
}

export function isStale(measuredOn: string, today: string, phase: Phase | null): boolean {
  return ageInDays(measuredOn, today) > staleAfterWeeks(phase) * 7;
}

export function describeAge(measuredOn: string, today: string): string {
  const days = ageInDays(measuredOn, today);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 70) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30.4)} months ago`;
}

export function formatClock(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatMarkerValue(metric: MarkerMetric, value: number): string {
  switch (metric) {
    case "ftp_w":
      return `FTP ${Math.round(value)} W`;
    case "lthr_bpm":
      return `LTHR ${Math.round(value)} bpm`;
    case "max_hr_bpm":
      return `max HR ${Math.round(value)} bpm`;
    case "threshold_pace_s_per_km":
      return `threshold pace ${formatClock(value)} /km`;
    case "css_s_per_100m":
      return `CSS ${formatClock(value)} /100 m`;
    case "vdot":
      return `VDOT ${value.toFixed(1)}`;
  }
}

const SOURCE_LABELS: Record<MarkerSource, string> = {
  intervals: "from Intervals.icu",
  field_test: "from a field test",
  race: "from a race",
  athlete_reported: "athlete-reported",
  activity: "from a hard workout",
};

export function describeSource(source: MarkerSource): string {
  return SOURCE_LABELS[source];
}

export type MissingAnchor = { sport: "run" | "bike" | "swim"; fieldTest: string };

// Sports trained recently that have no intensity anchor at all.
export function missingAnchors(
  markers: readonly Marker[],
  recentActivitySports: Iterable<string>,
): MissingAnchor[] {
  const trained = new Set<"run" | "bike" | "swim">();
  for (const sport of recentActivitySports) {
    const markerSport = markerSportOf(sport);
    if (markerSport) trained.add(markerSport);
  }
  return (["run", "bike", "swim"] as const)
    .filter((sport) => trained.has(sport))
    .filter(
      (sport) => !INTENSITY_ANCHORS[sport].some((metric) => findMarker(markers, sport, metric)),
    )
    .map((sport) => ({ sport, fieldTest: FIELD_TESTS[sport] }));
}

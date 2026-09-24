import type { LapSummary } from "../db/schema.js";
import type { Marker } from "./markers.js";
import type { FieldTest } from "./plan.js";

// ADR-016 source 3: markers from a completed field test, found in the activity's laps. The
// protocols (static system prompt) tell the athlete where to press lap, so the test effort
// is its own lap. No lap that fits → no proposal; the athlete can report the numbers in chat.

type TestActivity = {
  externalId: string;
  sport: string;
  startedOn: string; // local date
  laps: readonly LapSummary[] | null;
};

const between = (value: number, low: number, high: number) => value >= low && value <= high;

// A 20-minute lap (18-22 min moving).
const twentyMinuteLaps = (laps: readonly LapSummary[]) =>
  laps.filter((lap) => between(lap.movingSeconds, 1080, 1320));

export const FIELD_TEST_SPORTS: Record<FieldTest, readonly string[]> = {
  bike_ftp_20min: ["bike"],
  run_lthr_30min: ["run", "trail_run"],
  swim_css: ["swim"],
};

export function markersFromFieldTest(test: FieldTest, activity: TestActivity): Marker[] {
  if (!FIELD_TEST_SPORTS[test].includes(activity.sport) || !activity.laps) return [];
  const base = {
    measuredOn: activity.startedOn,
    source: "field_test" as const,
    sourceRef: activity.externalId,
  };

  switch (test) {
    case "bike_ftp_20min": {
      // The hardest 20-min lap: FTP = 95% of its average power, LTHR = its average HR.
      const [lap] = twentyMinuteLaps(activity.laps)
        .filter((l) => l.avgWatts)
        .sort((a, b) => (b.avgWatts ?? 0) - (a.avgWatts ?? 0));
      if (!lap?.avgWatts) return [];
      const markers: Marker[] = [
        {
          ...base,
          sport: "bike",
          metric: "ftp_w",
          value: Math.round(lap.avgWatts * 0.95),
          notes: `95% of ${Math.round(lap.avgWatts)} W over 20 min`,
        },
      ];
      if (lap.avgHr) {
        markers.push({
          ...base,
          sport: "bike",
          metric: "lthr_bpm",
          value: Math.round(lap.avgHr),
          notes: "average HR of the 20-min test",
        });
      }
      return markers;
    }

    case "run_lthr_30min": {
      // Friel: lap at 10 min, LTHR = average HR of the last 20 min; its pace ≈ threshold pace.
      const [lap] = twentyMinuteLaps(activity.laps)
        .filter((l) => l.avgHr && l.distanceMeters > 0)
        .sort((a, b) => b.distanceMeters / b.movingSeconds - a.distanceMeters / a.movingSeconds);
      if (!lap?.avgHr) return [];
      return [
        {
          ...base,
          sport: "run",
          metric: "lthr_bpm",
          value: Math.round(lap.avgHr),
          notes: "average HR of the last 20 min of the 30-min test",
        },
        {
          ...base,
          sport: "run",
          metric: "threshold_pace_s_per_km",
          value: Math.round((lap.movingSeconds / (lap.distanceMeters / 1000)) * 10) / 10,
          notes: "pace of the last 20 min of the 30-min test",
        },
      ];
    }

    case "swim_css": {
      // CSS (s/100 m) = (T400 - T200) / 2, from the two time-trial laps.
      const fastest = (low: number, high: number) =>
        activity.laps
          ?.filter((l) => between(l.distanceMeters, low, high))
          .sort((a, b) => a.elapsedSeconds - b.elapsedSeconds)[0];
      const t400 = fastest(390, 410);
      const t200 = fastest(190, 210);
      if (!t400 || !t200 || t400.elapsedSeconds <= t200.elapsedSeconds) return [];
      return [
        {
          ...base,
          sport: "swim",
          metric: "css_s_per_100m",
          value: Math.round(((t400.elapsedSeconds - t200.elapsedSeconds) / 2) * 10) / 10,
          notes: `400 m in ${t400.elapsedSeconds} s, 200 m in ${t200.elapsedSeconds} s`,
        },
      ];
    }
  }
}

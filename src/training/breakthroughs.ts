import type { LapSummary } from "../db/schema.js";
import { findMarker, formatClock, type Marker } from "./markers.js";
import { VDOT_MAX_DISTANCE_M, VDOT_MIN_DISTANCE_M, vdotFromRace } from "./vdot.js";

// ADR-016: an activity that clearly beats a current threshold proposes a new marker, so the
// athlete doesn't train on an outdated FTP or VDOT until the next field test. Only laps and
// whole-activity averages are available (no streams), so every estimate is a lower bound of
// what the athlete can do, and a proposal needs the athlete's confirmation anyway.

// "Clearly": the estimate must beat the current value by 3%. For FTP that's a >= 20-min
// effort above ~108% of FTP (95% of it = FTP + 3%), past the common "> 105% of FTP" rule,
// which a correctly set FTP already predicts for an all-out 20 minutes.
export const BREAKTHROUGH_MARGIN = 1.03;
// A VDOT jump this large is a GPS glitch or a mis-tagged ride, not fitness.
const MAX_VDOT_JUMP = 10;
const MIN_EFFORT_SECONDS = 20 * 60;

export type BreakthroughActivity = {
  externalId: string;
  name: string | null;
  sport: string;
  startedOn: string; // local date
  movingSeconds: number;
  distanceMeters: number | null;
  // Plain average power of the whole activity (not weighted/normalized).
  avgWatts: number | null;
  // Strava's `device_watts`: false when the power is estimated, not measured.
  measuredPower: boolean;
  // Strava's `trainer`: indoors (treadmill or trainer). Treadmill distance is unreliable.
  indoor: boolean;
  laps: readonly LapSummary[] | null;
};

type Effort = { seconds: number; meters: number; watts: number | null; label: string };

function efforts(activity: BreakthroughActivity): Effort[] {
  const whole: Effort = {
    seconds: activity.movingSeconds,
    meters: activity.distanceMeters ?? 0,
    watts: activity.avgWatts,
    label: "the whole activity",
  };
  const laps = (activity.laps ?? []).map((lap) => ({
    seconds: lap.movingSeconds,
    meters: lap.distanceMeters,
    watts: lap.avgWatts,
    label: `lap "${lap.name}"`,
  }));
  return [whole, ...laps].filter((effort) => effort.seconds > 0);
}

const minutes = (seconds: number) => Math.round(seconds / 60);

export function breakthroughMarkers(
  activity: BreakthroughActivity,
  current: readonly Marker[],
): Marker[] {
  const base = {
    measuredOn: activity.startedOn,
    source: "activity" as const,
    sourceRef: activity.externalId,
  };
  const where = activity.name ? ` in "${activity.name}"` : "";
  const markers: Marker[] = [];

  if (activity.sport === "bike" && activity.measuredPower) {
    const ftp = findMarker(current, "bike", "ftp_w");
    const [best] = efforts(activity)
      .filter((e) => e.seconds >= MIN_EFFORT_SECONDS && e.watts)
      .sort((a, b) => (b.watts ?? 0) - (a.watts ?? 0));
    if (ftp && best?.watts) {
      const estimate = Math.round(best.watts * 0.95);
      if (estimate >= ftp.value * BREAKTHROUGH_MARGIN) {
        markers.push({
          ...base,
          sport: "bike",
          metric: "ftp_w",
          value: estimate,
          notes: `95% of ${Math.round(best.watts)} W over ${minutes(best.seconds)} min (${best.label}${where}); was ${Math.round(ftp.value)} W`,
        });
      }
    }
  }

  // Outdoor road runs only: trail pace says little about flat-ground fitness, and treadmill
  // distance comes from a footpod or the belt's calibration.
  if (activity.sport === "run" && !activity.indoor) {
    const runEfforts = efforts(activity).filter((e) => e.meters > 0);

    const vdot = findMarker(current, "run", "vdot");
    const [bestVdot] = runEfforts
      .filter((e) => e.meters >= VDOT_MIN_DISTANCE_M && e.meters <= VDOT_MAX_DISTANCE_M)
      .map((e) => ({ effort: e, value: vdotFromRace(e.meters, e.seconds) }))
      .sort((a, b) => b.value - a.value);
    if (
      vdot &&
      bestVdot &&
      bestVdot.value >= vdot.value * BREAKTHROUGH_MARGIN &&
      bestVdot.value <= vdot.value + MAX_VDOT_JUMP
    ) {
      const { effort } = bestVdot;
      markers.push({
        ...base,
        sport: "run",
        metric: "vdot",
        value: Math.round(bestVdot.value * 10) / 10,
        notes: `${(effort.meters / 1000).toFixed(2)} km in ${formatClock(effort.seconds)} (${effort.label}${where}); was ${vdot.value.toFixed(1)}`,
      });
    }

    // Friel: the pace held over 20+ min of a solo effort is the threshold pace.
    const threshold = findMarker(current, "run", "threshold_pace_s_per_km");
    const [fastest] = runEfforts
      .filter((e) => e.seconds >= MIN_EFFORT_SECONDS)
      .map((e) => ({ effort: e, pace: e.seconds / (e.meters / 1000) }))
      .sort((a, b) => a.pace - b.pace);
    if (
      threshold &&
      fastest &&
      fastest.pace * BREAKTHROUGH_MARGIN <= threshold.value &&
      fastest.pace >= threshold.value * 0.7
    ) {
      markers.push({
        ...base,
        sport: "run",
        metric: "threshold_pace_s_per_km",
        value: Math.round(fastest.pace * 10) / 10,
        notes: `held over ${minutes(fastest.effort.seconds)} min (${fastest.effort.label}${where}); was ${formatClock(threshold.value)} /km`,
      });
    }
  }

  return markers;
}

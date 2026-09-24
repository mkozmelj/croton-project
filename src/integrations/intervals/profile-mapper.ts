import type { Marker, MarkerMetric, MarkerSport } from "../../training/markers.js";
import type { SportZones, Zone, ZoneSet, ZoneSport } from "../../training/zones.js";
import type { IntervalsAthlete, SportSettings } from "./client.js";

// Intervals.icu athlete settings → fitness markers and zone sets (ADR-016). Units are
// recorded in test-fixtures.ts: threshold_pace is m/s, power zones % of FTP, HR zones bpm.

const OPEN_ENDED = 999;

function sportOf(settings: SportSettings): ZoneSport | null {
  if (settings.types.includes("Ride")) return "bike";
  if (settings.types.includes("Run")) return "run";
  if (settings.types.includes("Swim")) return "swim";
  return null; // "Other" and custom groups
}

function mappedSettings(athlete: IntervalsAthlete): [ZoneSport, SportSettings][] {
  const result: [ZoneSport, SportSettings][] = [];
  for (const settings of athlete.sportSettings) {
    const sport = sportOf(settings);
    if (sport && !result.some(([s]) => s === sport)) result.push([sport, settings]);
  }
  return result;
}

const positive = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

// Markers dated `today` (the day the value was read; Intervals.icu doesn't say when it was set).
export function markersFromIntervals(athlete: IntervalsAthlete, today: string): Marker[] {
  const markers: Marker[] = [];
  const add = (sport: MarkerSport, metric: MarkerMetric, value: number) =>
    markers.push({ sport, metric, value, measuredOn: today, source: "intervals" });

  const settings = mappedSettings(athlete);
  for (const [sport, s] of settings) {
    if (sport === "bike" && positive(s.ftp)) add("bike", "ftp_w", s.ftp);
    if (positive(s.lthr)) add(sport, "lthr_bpm", s.lthr);
    if (positive(s.threshold_pace)) {
      if (sport === "run")
        add("run", "threshold_pace_s_per_km", oneDecimal(1000 / s.threshold_pace));
      if (sport === "swim") add("swim", "css_s_per_100m", oneDecimal(100 / s.threshold_pace));
    }
  }

  // Max HR is usually the same everywhere: one 'all' marker then, per sport otherwise.
  const maxHrs = settings.flatMap(([sport, s]) =>
    positive(s.max_hr) ? [[sport, s.max_hr] as const] : [],
  );
  const distinct = new Set(maxHrs.map(([, value]) => value));
  if (distinct.size === 1) {
    add("all", "max_hr_bpm", maxHrs[0]?.[1] ?? 0);
  } else {
    for (const [sport, value] of maxHrs) add(sport, "max_hr_bpm", value);
  }
  return markers;
}

function names(given: readonly string[] | null | undefined, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    given?.[i] ? `Z${i + 1} ${given[i]}` : `Z${i + 1}`,
  );
}

// Upper bounds → contiguous zones; the first is open below.
function fromUpperBounds(bounds: readonly number[], labels: string[], openTop: boolean): Zone[] {
  return bounds.map((upper, i) => ({
    name: labels[i] ?? `Z${i + 1}`,
    from: i === 0 ? null : (bounds[i - 1] ?? null),
    to: openTop && i === bounds.length - 1 ? null : upper,
  }));
}

export function zonesFromIntervals(athlete: IntervalsAthlete): SportZones {
  const zones: SportZones = {};
  for (const [sport, s] of mappedSettings(athlete)) {
    const sets: Partial<Record<"hr" | "power", ZoneSet>> = {};
    if (s.hr_zones?.length && positive(s.lthr)) {
      sets.hr = {
        unit: "bpm",
        source: "intervals",
        method: "Intervals.icu",
        basis: { metric: "lthr_bpm", value: s.lthr },
        zones: fromUpperBounds(s.hr_zones, names(s.hr_zone_names, s.hr_zones.length), false),
      };
    }
    if (sport === "bike" && s.power_zones?.length && positive(s.ftp)) {
      const ftp = s.ftp;
      const watts = s.power_zones.map((pct) =>
        pct >= OPEN_ENDED ? OPEN_ENDED : Math.round((pct / 100) * ftp),
      );
      sets.power = {
        unit: "W",
        source: "intervals",
        method: "Intervals.icu",
        basis: { metric: "ftp_w", value: ftp },
        zones: fromUpperBounds(
          watts,
          names(s.power_zone_names, watts.length),
          s.power_zones.at(-1) === OPEN_ENDED,
        ),
      };
    }
    if (sets.hr || sets.power) zones[sport] = sets;
  }
  return zones;
}

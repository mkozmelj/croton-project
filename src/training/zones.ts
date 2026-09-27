import { findMarker, formatClock, type Marker, type MarkerMetric } from "./markers.js";
import { danielsPaces } from "./vdot.js";

// ADR-016: zones are derived from the current markers, never edited by hand. Intervals.icu's
// own zones win for a sport when they were built on the same threshold as the current marker;
// otherwise they're computed here.

export type ZoneSport = "run" | "bike" | "swim";
export type ZoneKind = "hr" | "power" | "pace";

// Zones run from easiest to hardest. For HR and power `from` < `to`; for pace (seconds per
// km or per 100 m) `from` is the slower end. `null` is an open end.
export type Zone = { name: string; from: number | null; to: number | null };

export type ZoneSet = {
  unit: "bpm" | "W" | "s/km" | "s/100m";
  source: "intervals" | "computed";
  method: string;
  // The marker value the zones were built from; a changed marker invalidates them.
  basis: { metric: MarkerMetric; value: number };
  zones: Zone[];
};

export type SportZones = Partial<Record<ZoneSport, Partial<Record<ZoneKind, ZoneSet>>>>;

type Band = [name: string, from: number | null, to: number | null];

function scaled(bands: readonly Band[], base: number, digits = 0): Zone[] {
  const round = (value: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return bands.map(([name, from, to]) => ({
    name,
    from: from === null ? null : round(from * base),
    to: to === null ? null : round(to * base),
  }));
}

// Coggan power levels, % of FTP.
const COGGAN_POWER: readonly Band[] = [
  ["Z1 Active Recovery", null, 0.55],
  ["Z2 Endurance", 0.55, 0.75],
  ["Z3 Tempo", 0.75, 0.9],
  ["Z4 Threshold", 0.9, 1.05],
  ["Z5 VO2max", 1.05, 1.2],
  ["Z6 Anaerobic", 1.2, 1.5],
  ["Z7 Neuromuscular", 1.5, null],
];

// Friel HR zones, % of LTHR (running and cycling tables differ).
const FRIEL_HR: Record<"run" | "bike", readonly Band[]> = {
  run: [
    ["Z1 Recovery", null, 0.85],
    ["Z2 Aerobic", 0.85, 0.9],
    ["Z3 Tempo", 0.9, 0.95],
    ["Z4 SubThreshold", 0.95, 1.0],
    ["Z5a SuperThreshold", 1.0, 1.03],
    ["Z5b Aerobic Capacity", 1.03, 1.06],
    ["Z5c Anaerobic", 1.06, null],
  ],
  bike: [
    ["Z1 Recovery", null, 0.81],
    ["Z2 Aerobic", 0.81, 0.9],
    ["Z3 Tempo", 0.9, 0.94],
    ["Z4 SubThreshold", 0.94, 1.0],
    ["Z5a SuperThreshold", 1.0, 1.03],
    ["Z5b Aerobic Capacity", 1.03, 1.06],
    ["Z5c Anaerobic", 1.06, null],
  ],
};

// Friel run pace zones, % of threshold pace (as time per km: bigger = slower).
const FRIEL_RUN_PACE: readonly Band[] = [
  ["Z1 Recovery", null, 1.29],
  ["Z2 Aerobic", 1.29, 1.14],
  ["Z3 Tempo", 1.14, 1.06],
  ["Z4 SubThreshold", 1.06, 0.99],
  ["Z5a SuperThreshold", 0.99, 0.97],
  ["Z5b Aerobic Capacity", 0.97, 0.9],
  ["Z5c Anaerobic", 0.9, null],
];

// CSS-based swim zones: offsets in s/100 m from CSS pace.
const CSS_OFFSETS: readonly Band[] = [
  ["Z1 Recovery", null, 15],
  ["Z2 Endurance", 15, 8],
  ["Z3 Tempo", 8, 3],
  ["Z4 Threshold (CSS)", 3, -2],
  ["Z5 VO2max", -2, null],
];

export function cogganPowerZones(ftp: number): ZoneSet {
  return {
    unit: "W",
    source: "computed",
    method: "Coggan, % of FTP",
    basis: { metric: "ftp_w", value: ftp },
    zones: scaled(COGGAN_POWER, ftp),
  };
}

export function frielHrZones(lthr: number, sport: "run" | "bike"): ZoneSet {
  return {
    unit: "bpm",
    source: "computed",
    method: `Friel ${sport === "run" ? "running" : "cycling"}, % of LTHR`,
    basis: { metric: "lthr_bpm", value: lthr },
    zones: scaled(FRIEL_HR[sport], lthr),
  };
}

export function frielRunPaceZones(thresholdPaceSPerKm: number): ZoneSet {
  return {
    unit: "s/km",
    source: "computed",
    method: "Friel, % of threshold pace",
    basis: { metric: "threshold_pace_s_per_km", value: thresholdPaceSPerKm },
    zones: scaled(FRIEL_RUN_PACE, thresholdPaceSPerKm),
  };
}

export function danielsPaceZones(vdot: number): ZoneSet {
  const paces = danielsPaces(vdot);
  const round = (value: number) => Math.round(value);
  return {
    unit: "s/km",
    source: "computed",
    method: "Daniels training paces from VDOT",
    basis: { metric: "vdot", value: vdot },
    zones: [
      { name: "E easy/long", from: round(paces.E[0]), to: round(paces.E[1]) },
      { name: "M marathon", from: round(paces.M[0]), to: round(paces.M[1]) },
      { name: "T threshold", from: round(paces.T[0]), to: round(paces.T[1]) },
      { name: "I interval", from: round(paces.I[0]), to: round(paces.I[1]) },
      { name: "R repetition", from: round(paces.R[0]), to: round(paces.R[1]) },
    ],
  };
}

export function cssSwimZones(cssSPer100m: number): ZoneSet {
  return {
    unit: "s/100m",
    source: "computed",
    method: "CSS offsets",
    basis: { metric: "css_s_per_100m", value: cssSPer100m },
    zones: CSS_OFFSETS.map(([name, from, to]) => ({
      name,
      from: from === null ? null : cssSPer100m + from,
      to: to === null ? null : cssSPer100m + to,
    })),
  };
}

// Zones computed from the current markers alone.
export function computedZones(markers: readonly Marker[]): SportZones {
  const zones: SportZones = {};
  const put = (sport: ZoneSport, kind: ZoneKind, set: ZoneSet) => {
    zones[sport] = { ...zones[sport], [kind]: set };
  };

  const ftp = findMarker(markers, "bike", "ftp_w");
  if (ftp) put("bike", "power", cogganPowerZones(ftp.value));
  const bikeLthr = findMarker(markers, "bike", "lthr_bpm");
  if (bikeLthr) put("bike", "hr", frielHrZones(bikeLthr.value, "bike"));

  const runLthr = findMarker(markers, "run", "lthr_bpm");
  if (runLthr) put("run", "hr", frielHrZones(runLthr.value, "run"));
  // Pace from whichever of VDOT and threshold pace is newer.
  const vdot = findMarker(markers, "run", "vdot");
  const pace = findMarker(markers, "run", "threshold_pace_s_per_km");
  if (vdot && (!pace || vdot.measuredOn >= pace.measuredOn)) {
    put("run", "pace", danielsPaceZones(vdot.value));
  } else if (pace) {
    put("run", "pace", frielRunPaceZones(pace.value));
  }

  const css = findMarker(markers, "swim", "css_s_per_100m");
  if (css) put("swim", "pace", cssSwimZones(css.value));
  return zones;
}

const SPORTS: readonly ZoneSport[] = ["run", "bike", "swim"];
const KINDS: readonly ZoneKind[] = ["hr", "power", "pace"];

// The applied snapshot: Intervals.icu's zone set where it was built on the current marker
// value (same metric, same value), computed zones everywhere else.
export function deriveZones(markers: readonly Marker[], intervals: SportZones): SportZones {
  const computed = computedZones(markers);
  const result: SportZones = {};
  for (const sport of SPORTS) {
    for (const kind of KINDS) {
      const fromIntervals = intervals[sport]?.[kind];
      const current = fromIntervals
        ? findMarker(markers, sport, fromIntervals.basis.metric)
        : undefined;
      const set =
        fromIntervals && current && Math.abs(current.value - fromIntervals.basis.value) < 0.01
          ? fromIntervals
          : computed[sport]?.[kind];
      if (set) result[sport] = { ...result[sport], [kind]: set };
    }
  }
  return result;
}

// Only the Intervals.icu-sourced sets of a stored snapshot (to re-derive after a non-Intervals
// marker change without refetching).
export function intervalsZonesOf(snapshot: SportZones | null | undefined): SportZones {
  const result: SportZones = {};
  for (const sport of SPORTS) {
    for (const kind of KINDS) {
      const set = snapshot?.[sport]?.[kind];
      if (set?.source === "intervals") result[sport] = { ...result[sport], [kind]: set };
    }
  }
  return result;
}

function formatZoneValue(value: number, unit: ZoneSet["unit"]): string {
  return unit === "s/km" || unit === "s/100m" ? formatClock(value) : String(Math.round(value));
}

// e.g. "bike power (Coggan, % of FTP, FTP 250 W): Z1 Active Recovery <138, Z2 Endurance 138-188, ... W"
export function describeZoneSet(sport: ZoneSport, kind: ZoneKind, set: ZoneSet): string {
  const { source, zones, unitLabel } = zoneSetParts(set);
  return `${sport} ${kind} (${source}): ${zones.join(", ")} ${unitLabel}`;
}

// The pieces of describeZoneSet: where the set comes from, one "Z2 Endurance 138-188" per
// zone, and the unit.
export function zoneSetParts(set: ZoneSet): { source: string; zones: string[]; unitLabel: string } {
  const unitLabel = set.unit === "s/km" ? "/km" : set.unit === "s/100m" ? "/100 m" : set.unit;
  const zones = set.zones.map(({ name, from, to }) => {
    const f = from === null ? null : formatZoneValue(from, set.unit);
    const t = to === null ? null : formatZoneValue(to, set.unit);
    const isPace = set.unit === "s/km" || set.unit === "s/100m";
    if (f === null) return `${name} ${isPace ? "slower than" : "<"} ${t}`;
    if (t === null) return `${name} ${isPace ? "faster than" : ">"} ${f}`;
    return f === t ? `${name} ${f}` : `${name} ${f}-${t}`;
  });
  const source = set.source === "intervals" ? "from Intervals.icu" : set.method;
  return { source, zones, unitLabel };
}

export function describeZones(zones: SportZones | null | undefined): string[] {
  return listZoneSets(zones).map(({ sport, kind, set }) => describeZoneSet(sport, kind, set));
}

// Every stored set, sport by sport.
export function listZoneSets(
  zones: SportZones | null | undefined,
): { sport: ZoneSport; kind: ZoneKind; set: ZoneSet }[] {
  const sets: { sport: ZoneSport; kind: ZoneKind; set: ZoneSet }[] = [];
  for (const sport of SPORTS) {
    for (const kind of KINDS) {
      const set = zones?.[sport]?.[kind];
      if (set) sets.push({ sport, kind, set });
    }
  }
  return sets;
}

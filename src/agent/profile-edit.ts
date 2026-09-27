import type { Marker, MarkerMetric, MarkerSport } from "../training/markers.js";
import { VDOT_MAX_DISTANCE_M, VDOT_MIN_DISTANCE_M, vdotFromRace } from "../training/vdot.js";
import type { AddMarkerPayload, UpdateProfilePayload } from "./actions.js";
import { parseClock } from "./tool-handlers.js";

// `/profile <field> <value>`: the athlete edits the profile directly. Each edit becomes a
// proposal with Confirm/Cancel (ADR-007), so the parsed value is shown before it's saved.
// Zones aren't edited: they're derived from the markers (ADR-016).

export type ProfileEdit =
  | { ok: true; actionType: "add_fitness_marker"; payload: AddMarkerPayload }
  | { ok: true; actionType: "update_profile"; payload: UpdateProfilePayload }
  | { ok: false; error: string };

type Range = { min: number; max: number };

// Plausible values; anything outside is a typo.
const RANGES: Record<MarkerMetric, Range> = {
  ftp_w: { min: 50, max: 600 },
  lthr_bpm: { min: 90, max: 220 },
  max_hr_bpm: { min: 120, max: 230 },
  threshold_pace_s_per_km: { min: 150, max: 600 },
  css_s_per_100m: { min: 55, max: 240 },
  vdot: { min: 20, max: 90 },
};

const DISTANCES: Record<string, number> = { half: 21_097.5, marathon: 42_195 };

const fail = (error: string): ProfileEdit => ({ ok: false, error });

// "10k", "21.1k", "half", "marathon" or metres ("5000").
function parseDistance(text: string): number | null {
  const named = DISTANCES[text];
  if (named) return named;
  const km = text.match(/^(\d+(?:\.\d+)?)km?$/);
  if (km) return Number(km[1]) * 1000;
  return /^\d+$/.test(text) ? Number(text) : null;
}

function marker(
  sport: MarkerSport,
  metric: MarkerMetric,
  value: number,
  measuredOn: string,
  notes: string,
): ProfileEdit {
  const { min, max } = RANGES[metric];
  if (!Number.isFinite(value) || value < min || value > max) {
    return fail(`That value is outside the plausible range for ${metric} (${min}-${max}).`);
  }
  const m: Marker = { sport, metric, value, measuredOn, source: "athlete_reported", notes };
  return { ok: true, actionType: "add_fitness_marker", payload: { markers: [m] } };
}

function profileChange(changes: Partial<UpdateProfilePayload>): ProfileEdit {
  return {
    ok: true,
    actionType: "update_profile",
    payload: {
      name: null,
      background: null,
      availability: null,
      injuryNotes: null,
      raceMarkers: [],
      ...changes,
    },
  };
}

const HR_SPORTS = ["run", "bike", "swim"] as const;
const isHrSport = (text: string | undefined): text is (typeof HR_SPORTS)[number] =>
  (HR_SPORTS as readonly string[]).includes(text ?? "");

export function parseProfileEdit(args: string, today: string): ProfileEdit {
  const [rawField = "", ...rest] = args.trim().split(/\s+/);
  const field = rawField.toLowerCase();
  const text = args.trim().slice(rawField.length).trim();

  switch (field) {
    case "name":
      return text ? profileChange({ name: text }) : fail("Add the name: /profile name Alex");
    case "availability":
      return text
        ? profileChange({ availability: text })
        : fail("Add your availability: /profile availability Mon rest, Tue/Thu 6:30-7:45");
    case "injuries":
    case "injury":
      return text
        ? profileChange({ injuryNotes: text })
        : fail("Add the notes, or 'none': /profile injuries none");
  }

  // Markers: an optional trailing YYYY-MM-DD is the date it was measured (default today).
  const words = rest.map((word) => word.toLowerCase());
  let measuredOn = today;
  if (/^\d{4}-\d{2}-\d{2}$/.test(words.at(-1) ?? "")) {
    measuredOn = words.pop() ?? today;
    if (measuredOn > today || Number.isNaN(Date.parse(measuredOn))) {
      return fail("The date must be a real day, not in the future.");
    }
  }
  const notes = "set with /profile";
  const [first, second] = words;

  switch (field) {
    case "ftp":
      return marker("bike", "ftp_w", Number(first), measuredOn, notes);
    case "lthr":
      if (!isHrSport(first)) return fail("Say which sport: /profile lthr run 168");
      return marker(first, "lthr_bpm", Number(second), measuredOn, notes);
    case "maxhr":
      if (isHrSport(first)) return marker(first, "max_hr_bpm", Number(second), measuredOn, notes);
      return marker("all", "max_hr_bpm", Number(first), measuredOn, notes);
    case "pace":
      return marker(
        "run",
        "threshold_pace_s_per_km",
        parseClock(first ?? null) ?? Number.NaN,
        measuredOn,
        notes,
      );
    case "css":
      return marker(
        "swim",
        "css_s_per_100m",
        parseClock(first ?? null) ?? Number.NaN,
        measuredOn,
        notes,
      );
    case "vdot": {
      if (second === undefined) return marker("run", "vdot", Number(first), measuredOn, notes);
      // From a race: /profile vdot 10k 45:30 — computed in code (ADR-016).
      const distance = parseDistance(first ?? "");
      const time = parseClock(second);
      if (!distance || distance < VDOT_MIN_DISTANCE_M || distance > VDOT_MAX_DISTANCE_M) {
        return fail("The race distance must be between 1500 m and the marathon, e.g. 10k.");
      }
      if (!time) return fail("Give the race time as H:MM:SS or MM:SS, e.g. 45:30.");
      const vdot = Math.round(vdotFromRace(distance, time) * 10) / 10;
      return marker("run", "vdot", vdot, measuredOn, `from ${first} in ${second}`);
    }
    default:
      return fail(field ? `I don't know the field "${field}".` : "Say what to change.");
  }
}

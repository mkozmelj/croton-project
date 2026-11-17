// ADR-021: every planned session belongs to a session type, so the planner can progress a
// family of sessions instead of repeating one, and the dashboard can show each family over
// time. The list is fixed in code (structured output enforces it); adding a type needs no
// migration.

type TypeInfo = {
  // The plan sports a session of this type can be; "any" for races and field tests.
  sports: readonly string[] | "any";
  description: string;
};

const RUN = ["run", "trail_run"] as const;

const INFO = {
  run_recovery: { sports: RUN, description: "short Z1 run" },
  run_easy: { sports: RUN, description: "aerobic Z2, may end with strides" },
  run_long: { sports: RUN, description: "long aerobic run, Z1-Z2" },
  run_long_quality: { sports: RUN, description: "long run with tempo or race-pace segments" },
  run_tempo: { sports: RUN, description: "continuous Z3 / steady" },
  run_threshold: { sports: RUN, description: "threshold intervals, Z4" },
  run_vo2: { sports: RUN, description: "VO2max intervals, Z5, 2-5 min reps" },
  run_speed: { sports: RUN, description: "short fast reps or hill sprints, full recovery" },
  run_hills: { sports: RUN, description: "hill repeats for strength-endurance" },
  run_race_pace: { sports: RUN, description: "goal race-pace work" },
  bike_recovery: { sports: ["bike"], description: "Z1 spin" },
  bike_endurance: { sports: ["bike"], description: "aerobic Z2" },
  bike_long: { sports: ["bike"], description: "long Z2 ride" },
  bike_tempo: { sports: ["bike"], description: "Z3 blocks" },
  bike_sweet_spot: { sports: ["bike"], description: "88-94% FTP blocks" },
  bike_threshold: { sports: ["bike"], description: "Z4 intervals around FTP" },
  bike_vo2: { sports: ["bike"], description: "Z5, 2-6 min reps" },
  bike_sprint: { sports: ["bike"], description: "short maximal efforts" },
  bike_force: { sports: ["bike"], description: "low-cadence strength-endurance" },
  bike_race_pace: { sports: ["bike"], description: "goal race-power work" },
  swim_technique: { sports: ["swim"], description: "drills, easy aerobic" },
  swim_endurance: { sports: ["swim"], description: "longer aerobic sets" },
  swim_css: { sports: ["swim"], description: "threshold sets at CSS" },
  swim_speed: { sports: ["swim"], description: "short fast reps" },
  swim_open_water: { sports: ["swim"], description: "open-water session" },
  brick_aerobic: {
    sports: ["bike", ...RUN],
    description: "both legs of an aerobic brick (bike, then a short run off the bike)",
  },
  brick_race_pace: {
    sports: ["bike", ...RUN],
    description: "both legs of a race-pace brick",
  },
  strength_full_body: { sports: ["strength"], description: "general strength" },
  strength_lower: { sports: ["strength"], description: "legs and hips" },
  strength_upper_core: { sports: ["strength"], description: "upper body and core" },
  strength_power: { sports: ["strength"], description: "plyometrics, explosive work" },
  tennis: { sports: ["tennis"], description: "practice or match" },
  mobility: { sports: ["mobility"], description: "mobility, stretching, yoga" },
  field_test: { sports: "any", description: "a field test protocol (field_test is set)" },
  race: { sports: "any", description: "a race" },
  other_run: { sports: RUN, description: "a run nothing above fits" },
  other_bike: { sports: ["bike"], description: "a ride nothing above fits" },
  other_swim: { sports: ["swim"], description: "a swim nothing above fits" },
  other_strength: { sports: ["strength"], description: "strength nothing above fits" },
  other: { sports: ["other", "brick"], description: "anything else" },
} as const satisfies Record<string, TypeInfo>;

export type SessionType = keyof typeof INFO;

export const SESSION_TYPES = Object.keys(INFO) as [SessionType, ...SessionType[]];

// For the schema description: what each type means.
export const SESSION_TYPE_GUIDE = SESSION_TYPES.map((t) => `${t}: ${INFO[t].description}`).join(
  "; ",
);

export function sessionTypeFits(type: SessionType, sport: string): boolean {
  const sports: TypeInfo["sports"] = INFO[type].sports;
  return sports === "any" || sports.includes(sport);
}

export const isBrickType = (type: SessionType) => type.startsWith("brick_");

// The type a session gets when nothing better is known (sessions stored before ADR-021).
export function fallbackSessionType(sport: string): SessionType {
  switch (sport) {
    case "run":
    case "trail_run":
      return "other_run";
    case "bike":
      return "other_bike";
    case "swim":
      return "other_swim";
    case "strength":
      return "other_strength";
    case "tennis":
      return "tennis";
    case "mobility":
      return "mobility";
    default:
      return "other";
  }
}

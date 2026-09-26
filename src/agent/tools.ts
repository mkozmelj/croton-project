import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import { backgroundSchema } from "../training/background.js";
import { MARKER_METRICS } from "../training/markers.js";
import { weekPlanSchema } from "../training/plan.js";

// The single source of truth for the chat tools (stack doc §6); tool-handlers.ts runs them.
// The propose_* tools only *propose*: each creates a pending action (ADR-007) that the athlete
// confirms with a button. search_literature is read-only (ADR-014). Descriptions say when to
// call, because models under-trigger tools otherwise.

export const proposeGoalInput = z.object({
  event_name: z.string().describe("e.g. 'Ironman 70.3 Pula'"),
  event_date: z.iso.date().describe("Race day, YYYY-MM-DD; must be in the future"),
  sport: z.enum(["triathlon", "run", "trail_run", "bike", "swim", "other"]),
  distance: z
    .string()
    .nullable()
    .describe("Free text: '70.3', 'half marathon', '42 km / 2500 m D+'"),
  location: z.string().nullable(),
  priority: z
    .enum(["A", "B", "C"])
    .describe("A = main goal of the season, B = prioritized tune-up, C = train-through"),
  goal_type: z.enum(["finish", "time", "placing", "pb"]),
  target: z
    .string()
    .nullable()
    .describe("Human-readable target; for time goals use H:MM:SS, e.g. '4:45:00'"),
  notes: z.string().nullable(),
  replace_existing_a_goal: z
    .boolean()
    .describe(
      "true only after the athlete explicitly agreed to replace the season's current A goal",
    ),
});

export const proposeProfileInput = z.object({
  name: z.string().nullable(),
  background: backgroundSchema
    .nullable()
    .describe(
      "Training background. Race results in recent_results with sport 'run', distance and time get a VDOT computed automatically",
    ),
  availability: z
    .string()
    .nullable()
    .describe(
      "Weekly availability in the athlete's words, e.g. 'Mon rest, Tue/Thu 6:30-7:45, long sessions Sat'",
    ),
  injury_notes: z
    .string()
    .nullable()
    .describe("Current and past injuries relevant to training; replaces the stored notes"),
});

export const proposeMarkerInput = z.object({
  sport: z.enum(["run", "bike", "swim", "all"]),
  metric: z.enum(MARKER_METRICS),
  value: z
    .number()
    .nullable()
    .describe(
      "In the metric's unit (W, bpm, s/km, s/100 m, VDOT). null when `race` is given for a VDOT",
    ),
  race: z
    .object({ distance_meters: z.number(), time_seconds: z.number() })
    .nullable()
    .describe(
      "For metric 'vdot' from a flat running race: the VDOT is computed from this, don't compute it yourself",
    ),
  measured_on: z.iso
    .date()
    .describe("When the value was established (test or race date), not today"),
  source: z.enum(["field_test", "race", "athlete_reported"]),
  notes: z.string().nullable(),
});

export const proposePlanInput = weekPlanSchema.extend({
  reason: z.string().describe("One line on what changed and why, shown to the athlete"),
});

export const searchLiteratureInput = z.object({
  query: z
    .string()
    .min(3)
    .describe(
      "A focused topic or question in English, e.g. 'taper length and volume reduction before a half-Ironman'",
    ),
  max_results: z.number().int().min(1).max(8).nullable().describe("Default 5"),
});

function inputSchema(schema: z.ZodType): Tool.InputSchema {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { ...json, type: "object" };
}

export const TOOL_NAMES = {
  goal: "propose_goal",
  profile: "propose_profile_update",
  marker: "propose_fitness_marker",
  plan: "propose_week_plan",
  literature: "search_literature",
} as const;

export const SEARCH_LITERATURE_TOOL: Tool = {
  name: TOOL_NAMES.literature,
  description:
    "Search the coaching library: sports-science papers (polarized training, intensity distribution, ACWR and load, tapering, HRV-guided training), coaching articles, and excerpts from training books. Call this when the athlete asks a specific training-science question that the TRAINING PRINCIPLES don't settle (e.g. how long to taper, what the research says about a method, how to structure a particular session type), or when a planning decision would benefit from a source. Don't call it for questions about the athlete's own data, plan or schedule. Returns the most relevant passages, each with its source and page or location; cite the ones you use briefly, e.g. (Bosquet 2007, p. 4). If nothing relevant comes back, say so and answer from the principles.",
  input_schema: inputSchema(searchLiteratureInput),
};

// Order and content are fixed: tools are part of the cached prompt prefix (ADR-004).
export const CHAT_TOOLS: Tool[] = [
  {
    name: TOOL_NAMES.goal,
    description:
      "Propose a season goal tied to a dated race. Call this when the athlete states a target race or goal (e.g. 'my main goal for 2027 is sub-4:45 at 70.3 Pula on 2027-09-26'). Nothing is saved until the athlete taps Confirm under your reply. If it's rejected because an A goal already exists, ask whether to replace it and call again with replace_existing_a_goal only if they say yes.",
    input_schema: inputSchema(proposeGoalInput),
  },
  {
    name: TOOL_NAMES.profile,
    description:
      "Propose an update to the athlete profile: name, training background (years per sport, typical weekly hours, race results from the last ~18 months), weekly availability, injury notes. Call this during onboarding once you've collected the answers, or whenever the athlete tells you about a lasting change (new availability, an injury). Only the fields you pass are changed. Nothing is saved until the athlete confirms.",
    input_schema: inputSchema(proposeProfileInput),
  },
  {
    name: TOOL_NAMES.marker,
    description:
      "Propose a fitness marker (threshold value): FTP, LTHR, max HR, run threshold pace, swim CSS or VDOT. Call this when the athlete reports a test result, a race result, or a threshold they know, and it's not already in the context with the same value. For VDOT from a race, pass `race` and leave `value` null: the VDOT is computed in code. Nothing is saved until the athlete confirms; zones are re-derived afterwards.",
    input_schema: inputSchema(proposeMarkerInput),
  },
  {
    name: TOOL_NAMES.plan,
    description:
      "Propose the complete plan for one week (this week or next week) in place of the stored one. Call this when the athlete asks to change the plan (move, swap, add, drop or shorten sessions) or asks for a plan outside the Sunday recap. Include every session of the week, unchanged ones too. Sessions on days before today are kept from the stored plan whatever you pass. Keep the week's intensity distribution. Nothing is saved or put in the calendar until the athlete confirms.",
    input_schema: inputSchema(proposePlanInput),
  },
  SEARCH_LITERATURE_TOOL,
];

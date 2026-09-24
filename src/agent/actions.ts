import { z } from "zod";
import type { PendingActionRow, PendingActionType } from "../db/pending-actions.js";
import { backgroundSchema } from "../training/background.js";
import {
  describeSource,
  formatMarkerValue,
  MARKER_METRICS,
  MARKER_SOURCES,
  MARKER_SPORTS,
  type Marker,
} from "../training/markers.js";
import { weekPlanSchema, workoutSchema } from "../training/plan.js";
import { formatDuration } from "./activity-format.js";
import { planText } from "./plan-format.js";

// ADR-007 payloads, one schema per action type. Written by tool handlers and the planner,
// parsed again when the athlete confirms (a row is data from the DB, validated like any
// other boundary).

// How long a proposal stays confirmable; a stale plan shouldn't be booked days later.
export const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
export const RECAP_TTL_MS = 24 * 60 * 60 * 1000;
export const ONBOARDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const CONFIRMATION_TYPES = [
  "set_goal",
  "update_profile",
  "add_fitness_marker",
  "apply_plan",
] as const satisfies readonly PendingActionType[];

const markerSchema = z.object({
  sport: z.enum(MARKER_SPORTS),
  metric: z.enum(MARKER_METRICS),
  value: z.number(),
  measuredOn: z.iso.date(),
  source: z.enum(MARKER_SOURCES),
  sourceRef: z.string().nullish(),
  notes: z.string().nullish(),
});

export const setGoalPayload = z.object({
  event: z.object({
    name: z.string(),
    date: z.iso.date(),
    sport: z.string(),
    distance: z.string().nullable(),
    location: z.string().nullable(),
  }),
  goal: z.object({
    season: z.number().int(),
    priority: z.enum(["A", "B", "C"]),
    goalType: z.enum(["finish", "time", "placing", "pb"]),
    target: z.string().nullable(),
    targetSeconds: z.number().int().nullable(),
    notes: z.string().nullable(),
  }),
  // The active A goal this one replaces (set to 'dropped' on confirm).
  replaceGoal: z.object({ id: z.number().int(), name: z.string() }).nullable(),
});

export const updateProfilePayload = z.object({
  name: z.string().nullable(),
  background: backgroundSchema.nullable(),
  availability: z.string().nullable(),
  injuryNotes: z.string().nullable(),
  // VDOT markers computed from background.recent_results (ADR-016).
  raceMarkers: z.array(markerSchema),
});

export const addMarkerPayload = z.object({ markers: z.array(markerSchema).min(1) });

export const applyPlanPayload = z.object({
  plan: weekPlanSchema.extend({
    workouts: z.array(workoutSchema.extend({ calendar_event_id: z.string().nullish() })),
  }),
  recapNotes: z.string().nullable(),
  agentAnalysis: z.string().nullable(),
  reason: z.string().nullable(),
});

export const recapPayload = z.object({ weekStart: z.iso.date() });

export type SetGoalPayload = z.infer<typeof setGoalPayload>;
export type UpdateProfilePayload = z.infer<typeof updateProfilePayload>;
export type AddMarkerPayload = z.infer<typeof addMarkerPayload>;
export type ApplyPlanPayload = z.infer<typeof applyPlanPayload>;

export const isConfirmation = (type: PendingActionType) =>
  (CONFIRMATION_TYPES as readonly string[]).includes(type);

function markerLine(marker: Marker): string {
  const via = marker.notes ? ` (${marker.notes})` : "";
  return `${marker.sport}: ${formatMarkerValue(marker.metric, marker.value)}, ${describeSource(marker.source)}, ${marker.measuredOn}${via}`;
}

// What the athlete confirms, rendered by code from the payload — never the model's paraphrase.
export function describeProposal(row: Pick<PendingActionRow, "actionType" | "payload">): string {
  switch (row.actionType) {
    case "set_goal": {
      const { event, goal, replaceGoal } = setGoalPayload.parse(row.payload);
      const lines = [
        `New ${goal.priority} goal for ${goal.season}: ${event.name} (${[event.sport, event.distance].filter(Boolean).join(", ")}) on ${event.date}${event.location ? ` in ${event.location}` : ""}`,
        `Goal: ${goal.goalType}${goal.target ? `, ${goal.target}` : ""}`,
      ];
      if (goal.notes) lines.push(`Notes: ${goal.notes}`);
      if (replaceGoal) lines.push(`Replaces the current A goal: ${replaceGoal.name}`);
      return lines.join("\n");
    }
    case "update_profile": {
      const p = updateProfilePayload.parse(row.payload);
      const lines = ["Profile update:"];
      if (p.name) lines.push(`- Name: ${p.name}`);
      if (p.background) {
        const b = p.background;
        if (b.years_by_sport.length > 0) {
          lines.push(
            `- Years training: ${b.years_by_sport.map((y) => `${y.sport} ${y.years}`).join(", ")}`,
          );
        }
        if (b.typical_weekly_hours != null)
          lines.push(`- Typical week: ${b.typical_weekly_hours} h`);
        for (const r of b.recent_results) {
          const time = r.time_seconds ? `, ${formatDuration(r.time_seconds)}` : "";
          lines.push(`- Result ${r.date}: ${r.event}${time}`);
        }
        if (b.notes) lines.push(`- Notes: ${b.notes}`);
      }
      if (p.availability) lines.push(`- Availability: ${p.availability}`);
      if (p.injuryNotes) lines.push(`- Injuries: ${p.injuryNotes}`);
      for (const marker of p.raceMarkers) lines.push(`- Adds ${markerLine(marker)}`);
      return lines.join("\n");
    }
    case "add_fitness_marker": {
      const { markers } = addMarkerPayload.parse(row.payload);
      return ["New fitness marker:", ...markers.map((m) => `- ${markerLine(m)}`)].join("\n");
    }
    case "apply_plan": {
      const { plan, reason } = applyPlanPayload.parse(row.payload);
      return [reason ? `Plan change: ${reason}` : "Proposed plan:", "", planText(plan)].join("\n");
    }
    case "recap":
      return "Weekly recap: waiting for your feedback.";
    case "onboarding":
      return "Onboarding in progress.";
  }
}

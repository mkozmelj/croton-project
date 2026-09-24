import type { ToolUseBlock } from "@anthropic-ai/sdk/resources/messages/messages";
import type { z } from "zod";
import type { GoalStore } from "../db/goals.js";
import type { PendingActionRow, PendingActionStore } from "../db/pending-actions.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import type { Background } from "../training/background.js";
import { formatMarkerValue, type Marker, METRICS_BY_SPORT } from "../training/markers.js";
import { planIssues } from "../training/plan.js";
import { VDOT_MAX_DISTANCE_M, VDOT_MIN_DISTANCE_M, vdotFromRace } from "../training/vdot.js";
import { addDays, weekStart } from "../utils/dates.js";
import {
  type AddMarkerPayload,
  type ApplyPlanPayload,
  CONFIRMATION_TTL_MS,
  describeProposal,
  type SetGoalPayload,
  type UpdateProfilePayload,
} from "./actions.js";
import {
  proposeGoalInput,
  proposeMarkerInput,
  proposePlanInput,
  proposeProfileInput,
  TOOL_NAMES,
} from "./tools.js";

type ToolDeps = {
  pending: Pick<PendingActionStore, "create" | "clear">;
  goals: Pick<GoalStore, "activeInSeasons">;
  plans: Pick<TrainingPlanStore, "forWeek">;
};

export type ToolCallContext = { chatId: number; now: Date; today: string };

export type ToolOutcome = {
  content: string;
  isError: boolean;
  // Set when the call created a proposal the athlete now has to confirm.
  proposal?: PendingActionRow;
};

export type ToolHandlers = {
  run(call: Pick<ToolUseBlock, "name" | "input">, context: ToolCallContext): Promise<ToolOutcome>;
};

const failure = (content: string): ToolOutcome => ({ content, isError: true });

// "4:45:00" / "45:30" → seconds.
export function parseClock(text: string | null): number | null {
  const match = text?.trim().match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// VDOT markers for the running results in a background (ADR-016).
export function raceMarkersFrom(background: Background | null): Marker[] {
  if (!background) return [];
  return background.recent_results.flatMap((result) => {
    const { distance_meters: distance, time_seconds: time } = result;
    if (result.sport !== "run" || !distance || !time) return [];
    if (distance < VDOT_MIN_DISTANCE_M || distance > VDOT_MAX_DISTANCE_M) return [];
    return [
      {
        sport: "run" as const,
        metric: "vdot" as const,
        value: Math.round(vdotFromRace(distance, time) * 10) / 10,
        measuredOn: result.date,
        source: "race" as const,
        notes: result.event,
      },
    ];
  });
}

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  async function propose(
    context: ToolCallContext,
    actionType: PendingActionRow["actionType"],
    payload: unknown,
  ): Promise<ToolOutcome> {
    const proposal = await deps.pending.create({
      chatId: context.chatId,
      actionType,
      payload,
      expiresAt: new Date(context.now.getTime() + CONFIRMATION_TTL_MS),
    });
    return {
      content: [
        `Proposal #${proposal.id} created. Under your reply the athlete sees this summary with Confirm/Cancel buttons:`,
        describeProposal(proposal),
        "",
        "Don't repeat it in full; say briefly what you proposed and ask them to confirm with the button.",
      ].join("\n"),
      isError: false,
      proposal,
    };
  }

  const handlers: Record<
    string,
    (input: unknown, context: ToolCallContext) => Promise<ToolOutcome>
  > = {
    async [TOOL_NAMES.goal](raw, context) {
      const input = parse(proposeGoalInput, raw);
      if (typeof input === "string") return failure(input);
      if (input.event_date <= context.today) {
        return failure(`event_date ${input.event_date} is not in the future.`);
      }
      const season = Number(input.event_date.slice(0, 4));
      let replaceGoal: SetGoalPayload["replaceGoal"] = null;
      if (input.priority === "A") {
        const [current] = (await deps.goals.activeInSeasons([season])).filter(
          (g) => g.priority === "A",
        );
        if (current && !input.replace_existing_a_goal) {
          return failure(
            `Season ${season} already has an active A goal: ${current.event.name} on ${current.event.date}. Only one A goal per season. Ask the athlete whether this new goal should replace it (the old one is then dropped) or become a B goal.`,
          );
        }
        if (current) replaceGoal = { id: current.id, name: current.event.name };
      }
      const payload: SetGoalPayload = {
        event: {
          name: input.event_name,
          date: input.event_date,
          sport: input.sport,
          distance: input.distance,
          location: input.location,
        },
        goal: {
          season,
          priority: input.priority,
          goalType: input.goal_type,
          target: input.target,
          targetSeconds: input.goal_type === "time" ? parseClock(input.target) : null,
          notes: input.notes,
        },
        replaceGoal,
      };
      return propose(context, "set_goal", payload);
    },

    async [TOOL_NAMES.profile](raw, context) {
      const input = parse(proposeProfileInput, raw);
      if (typeof input === "string") return failure(input);
      if (!input.name && !input.background && !input.availability && !input.injury_notes) {
        return failure("Nothing to update: pass at least one field.");
      }
      const payload: UpdateProfilePayload = {
        name: input.name,
        background: input.background,
        availability: input.availability,
        injuryNotes: input.injury_notes,
        raceMarkers: raceMarkersFrom(input.background),
      };
      return propose(context, "update_profile", payload);
    },

    async [TOOL_NAMES.marker](raw, context) {
      const input = parse(proposeMarkerInput, raw);
      if (typeof input === "string") return failure(input);
      if (!METRICS_BY_SPORT[input.sport].includes(input.metric)) {
        return failure(
          `${input.metric} doesn't apply to ${input.sport}; valid: ${METRICS_BY_SPORT[input.sport].join(", ")}.`,
        );
      }
      if (input.measured_on > context.today) return failure("measured_on is in the future.");
      let value = input.value;
      if (input.metric === "vdot" && input.race) {
        const { distance_meters: distance, time_seconds: time } = input.race;
        if (distance < VDOT_MIN_DISTANCE_M || distance > VDOT_MAX_DISTANCE_M || time <= 0) {
          return failure("VDOT needs a flat running race between 1500 m and the marathon.");
        }
        value = Math.round(vdotFromRace(distance, time) * 10) / 10;
      }
      if (value === null || !Number.isFinite(value) || value <= 0) {
        return failure("Pass a positive value (or `race` for a VDOT).");
      }
      const marker: Marker = {
        sport: input.sport,
        metric: input.metric,
        value,
        measuredOn: input.measured_on,
        source: input.source,
        notes: input.notes ?? (input.race ? "computed from the race result" : null),
      };
      const payload: AddMarkerPayload = { markers: [marker] };
      const outcome = await propose(context, "add_fitness_marker", payload);
      return {
        ...outcome,
        content: `${formatMarkerValue(marker.metric, marker.value)}. ${outcome.content}`,
      };
    },

    async [TOOL_NAMES.plan](raw, context) {
      const input = parse(proposePlanInput, raw);
      if (typeof input === "string") return failure(input);
      const { reason, ...plan } = input;
      const thisWeek = weekStart(context.today);
      if (plan.week_start !== thisWeek && plan.week_start !== addDays(thisWeek, 7)) {
        return failure(`week_start must be this week's Monday (${thisWeek}) or next week's.`);
      }
      const issues = planIssues(plan);
      if (issues.length > 0) return failure(`Fix these and call again:\n- ${issues.join("\n- ")}`);
      const stored = await deps.plans.forWeek(plan.week_start);
      const payload: ApplyPlanPayload = {
        plan,
        recapNotes: null,
        agentAnalysis: null,
        reason,
      };
      // One plan proposal at a time: a newer one supersedes the last.
      await deps.pending.clear(context.chatId, ["apply_plan"]);
      const outcome = await propose(context, "apply_plan", payload);
      const note = stored ? "" : " (No plan was stored for that week yet.)";
      return { ...outcome, content: outcome.content + note };
    },
  };

  return {
    async run(call, context) {
      const handler = handlers[call.name];
      if (!handler) return failure(`Unknown tool ${call.name}.`);
      return handler(call.input, context);
    },
  };
}

// Tool input is model output: validated like any other boundary. Errors go back to the model.
function parse<T>(schema: z.ZodType<T>, input: unknown): T | string {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  return `Invalid input: ${result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
}

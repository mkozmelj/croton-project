import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import type { ClaudeRequest } from "./claude.js";
import { createPlanner, planTargetWeek } from "./planner.js";
import { inMemoryConversations, inMemoryPending } from "./test-helpers.js";

// Sunday 27 Sep 2026, 19:05 in Ljubljana.
const NOW = new Date("2026-09-27T17:05:00Z");

const session = (date: string, start_time = "07:00") => ({
  date,
  start_time,
  sport: "run",
  title: "Easy run",
  duration_minutes: 45,
  intensity: "easy",
  structure: [{ segment: "main", description: "45 min Z2" }],
  targets: "HR 130-145",
  field_test: null,
  notes: null,
});

const output = {
  recap: "Solid week. Next week builds aerobic volume.",
  plan: {
    week_start: "2026-09-28",
    phase: "base",
    focus: "Aerobic volume",
    workouts: [session("2026-09-29"), session("2026-10-01", "7am"), session("2026-10-09")],
    weekly_targets: { total_hours: 4, run_km: 35, bike_km: null, swim_km: null, easy_percent: 85 },
  },
};

const message = (text: string, stop: Message["stop_reason"] = "end_turn") =>
  ({
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 50 },
  }) as Message;

function setup(
  reply: Message,
  calendarLines: string[] | null = ['- Tue 29 Sep 09:00-17:00: "Work"'],
  refreshThresholds?: () => Promise<unknown>,
) {
  const calls: ClaudeRequest[] = [];
  const contexts: unknown[] = [];
  const conversations = inMemoryConversations();
  const pending = inMemoryPending(() => NOW);
  const planner = createPlanner({
    claude: {
      call: async (request) => {
        calls.push(request);
        return { message: reply, model: MODELS.sonnet, costEur: 0.1 };
      },
    },
    context: {
      build: async (options) => {
        contexts.push(options);
        return "CONTEXT";
      },
    },
    conversations,
    pending: pending.store,
    calendar: { weekLines: async () => calendarLines },
    ...(refreshThresholds ? { refreshThresholds } : {}),
    chatId: 1,
    timeZone: "Europe/Ljubljana",
    logger: pino({ level: "silent" }),
    now: () => NOW,
  });
  return { planner, calls, contexts, conversations, pending };
}

describe("planTargetWeek", () => {
  it.each([
    ["2026-09-24", "2026-09-21"], // Thursday: rest of this week
    ["2026-09-25", "2026-09-28"], // Friday: next week
    ["2026-09-27", "2026-09-28"], // Sunday: next week
  ])("on %s plans the week of %s", (today, week) => {
    expect(planTargetWeek(today)).toBe(week);
  });
});

describe("createPlanner", () => {
  it("opens a recap for next week", async () => {
    const { planner, pending } = setup(message("{}"));
    expect(await planner.startRecap()).toContain("week of Mon 2026-09-28");
    expect(pending.rows()).toMatchObject([
      { actionType: "recap", payload: { weekStart: "2026-09-28" } },
    ]);
  });

  it("generates with structured output and the 6-week baseline, and proposes the plan", async () => {
    const { planner, calls, contexts, conversations, pending } = setup(
      message(JSON.stringify(output)),
    );
    const reply = await planner.generate({ feedback: "Legs fine, busy Tuesday" });

    expect(calls[0]?.callType).toBe("plan_generation");
    expect(calls[0]?.outputFormat?.type).toBe("json_schema");
    const prompt = JSON.stringify(calls[0]?.messages);
    expect(prompt).toContain("<athlete_feedback>Legs fine, busy Tuesday</athlete_feedback>");
    expect(prompt).toContain("Work");
    expect(contexts[0]).toEqual({ detail: "baseline", planWeek: "2026-09-28" });

    // The 7am session and the one outside the week are dropped and reported.
    expect(reply.text).toContain("Solid week.");
    expect(reply.text).toContain("2 session(s) had invalid dates or times");
    expect(reply.proposals).toHaveLength(1);
    const payload = pending.rows()[0]?.payload as {
      plan: { workouts: unknown[] };
      recapNotes: string;
    };
    expect(payload.plan.workouts).toHaveLength(1);
    expect(payload.recapNotes).toBe("Legs fine, busy Tuesday");
    expect(conversations.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("proposes nothing when the output isn't a plan", async () => {
    const { planner, pending } = setup(message("not json"));
    const reply = await planner.generate({ feedback: "ok" });
    expect(reply.proposals).toEqual([]);
    expect(reply.text).toContain("malformed");
    expect(pending.rows()).toHaveLength(0);
  });

  it("passes a cut-off reply through instead of parsing it", async () => {
    const { planner } = setup(message('{"recap": "Solid', "max_tokens"));
    expect((await planner.generate({ feedback: "ok" })).text).toContain("cut off");
  });

  it("refreshes thresholds before planning and still plans when that fails", async () => {
    let refreshed = 0;
    const ok = setup(message(JSON.stringify(output)), null, async () => {
      refreshed++;
    });
    await ok.planner.generate({ feedback: "ok" });
    expect(refreshed).toBe(1);

    const failing = setup(message(JSON.stringify(output)), null, async () => {
      throw new Error("intervals down");
    });
    expect((await failing.planner.generate({ feedback: "ok" })).proposals).toHaveLength(1);
  });
});

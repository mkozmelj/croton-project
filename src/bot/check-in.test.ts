import type { InlineKeyboardMarkup, Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import type { PlannedWorkoutRow } from "../db/planned-workouts.js";
import type { CheckInAnswer } from "../db/training-plans.js";
import {
  checkInKeyboard,
  checkInText,
  registerCheckInHandlers,
  sessionIdsInKeyboard,
} from "./check-in.js";
import { offlineBot } from "./test-helpers.js";

const CHAT = 1001;
const NOW = new Date("2026-11-25T07:00:00Z");

function row(overrides: Partial<PlannedWorkoutRow>): PlannedWorkoutRow {
  return {
    id: 1,
    key: "croton:test:1",
    weekStart: "2026-11-23",
    date: "2026-11-24",
    startTime: "07:00",
    sport: "run",
    sessionType: "run_easy",
    title: "Easy run",
    intensity: "easy",
    durationMinutes: 45,
    activeMinutes: 45,
    structure: [],
    steps: null,
    targets: null,
    fieldTest: null,
    notes: null,
    status: "unconfirmed",
    statusSource: null,
    activityId: null,
    brickWith: null,
    replacedBy: null,
    calendarEventId: null,
    source: "plan",
    mainSet: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const labels = (markup: InlineKeyboardMarkup) =>
  markup.inline_keyboard.map((buttons) => buttons.map((button) => button.text));

function tap(data: string, markup: InlineKeyboardMarkup): Update {
  return {
    update_id: 5,
    callback_query: {
      id: "cb1",
      chat_instance: "ci",
      from: { id: CHAT, is_bot: false, first_name: "Athlete" },
      data,
      message: {
        message_id: 77,
        date: 0,
        chat: { id: CHAT, type: "private", first_name: "Athlete" },
        text: "How did these go?",
        reply_markup: markup,
      },
    },
  };
}

function setup(rows: PlannedWorkoutRow[]) {
  const { bot, calls } = offlineBot();
  const stored = new Map(rows.map((r) => [r.id, r]));
  const answers: { id: number; status: CheckInAnswer; today: string }[] = [];
  registerCheckInHandlers(bot, {
    plans: {
      async setAnswer(id, status, today) {
        answers.push({ id, status, today });
        const session = stored.get(id);
        if (!session || session.activityId !== null) return false;
        stored.set(id, { ...session, status, statusSource: "athlete" });
        return true;
      },
    },
    sessions: {
      async byId(id) {
        const session = stored.get(id);
        return session ? { session, activity: null, feedback: null } : null;
      },
    },
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  const payloads = (method: string) =>
    calls.filter((c) => c.method === method).map((c) => c.payload as Record<string, unknown>);
  return { bot, answers, payloads };
}

const RUN = row({ id: 1 });
const SWIM = row({ id: 2, sport: "swim", title: "CSS <set>", activeMinutes: 48 });

describe("checkInKeyboard", () => {
  it("numbers the rows when there are several sessions and marks stored answers", () => {
    expect(labels(checkInKeyboard([RUN, { ...SWIM, status: "partial" }]))).toEqual([
      ["1: Done", "1: Partly", "1: Skipped"],
      ["2: Done", "✓2: Partly", "2: Skipped"],
    ]);
    expect(labels(checkInKeyboard([RUN]))).toEqual([["Done", "Partly", "Skipped"]]);
  });

  it("round-trips the session ids through the sent buttons", () => {
    expect(sessionIdsInKeyboard(checkInKeyboard([RUN, SWIM]))).toEqual([1, 2]);
    expect(sessionIdsInKeyboard(undefined)).toEqual([]);
  });
});

describe("checkInText", () => {
  it("lists each session with its day and active minutes, escaped", () => {
    const text = checkInText([RUN, SWIM]);
    expect(text).toContain("How did these go?");
    expect(text).toContain("1. 🏃 Tue 24 Nov · Easy run · 45 min");
    expect(text).toContain("CSS &lt;set&gt; · 48 min");
  });

  it("says when a Strava activity or the timeout decided a session", () => {
    expect(checkInText([{ ...RUN, status: "done", statusSource: "match" }])).toContain(
      "A Strava activity counts for it now",
    );
    expect(checkInText([{ ...RUN, status: "skipped", statusSource: "timeout" }])).toContain(
      "no answer in time",
    );
  });
});

describe("registerCheckInHandlers", () => {
  it("stores the answer and redraws every session in the message", async () => {
    const { bot, answers, payloads } = setup([RUN, SWIM]);
    await bot.handleUpdate(tap("pw:2:skipped", checkInKeyboard([RUN, SWIM])));

    expect(answers).toEqual([{ id: 2, status: "skipped", today: "2026-11-25" }]);
    const edit = payloads("editMessageText").at(-1);
    expect(labels(edit?.reply_markup as InlineKeyboardMarkup)).toEqual([
      ["1: Done", "1: Partly", "1: Skipped"],
      ["2: Done", "2: Partly", "✓2: Skipped"],
    ]);
    expect(payloads("answerCallbackQuery").at(-1)).toMatchObject({ text: "Saved" });
  });

  it("says so when a matched session keeps its match", async () => {
    const matched = {
      ...RUN,
      activityId: 9,
      status: "done" as const,
      statusSource: "match" as const,
    };
    const { bot, payloads } = setup([matched]);
    await bot.handleUpdate(tap("pw:1:skipped", checkInKeyboard([RUN])));
    expect(payloads("answerCallbackQuery").at(-1)?.text).toContain("Not changed");
    expect(
      labels(payloads("editMessageText").at(-1)?.reply_markup as InlineKeyboardMarkup),
    ).toEqual([["✓Done", "Partly", "Skipped"]]);
  });

  it("removes the buttons when the sessions are gone", async () => {
    const { bot, payloads } = setup([]);
    await bot.handleUpdate(tap("pw:1:done", checkInKeyboard([RUN])));
    expect(payloads("editMessageReplyMarkup")).toHaveLength(1);
    expect(payloads("editMessageText")).toEqual([]);
  });

  it("ignores answers that aren't on the keyboard", async () => {
    const { bot, answers } = setup([RUN]);
    await bot.handleUpdate(tap("pw:1:maybe", checkInKeyboard([RUN])));
    expect(answers).toEqual([]);
  });
});

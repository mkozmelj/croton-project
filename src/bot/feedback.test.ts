import type { InlineKeyboardMarkup, Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { inMemoryFeedback, inMemoryPending } from "../agent/test-helpers.js";
import { storedActivity } from "../integrations/strava/test-fixtures.js";
import {
  feedbackKeyboard,
  feedbackText,
  questionsInKeyboard,
  registerFeedbackHandlers,
} from "./feedback.js";
import { offlineBot } from "./test-helpers.js";

const CHAT = 1001;
const NOW = new Date("2026-09-22T06:00:00Z");
const ACTIVITY = storedActivity({ id: 1, name: "Tempo <3>" });

const labels = (markup: InlineKeyboardMarkup) =>
  markup.inline_keyboard.map((row) => row.map((button) => button.text));

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
        text: "How did it feel?",
        reply_markup: markup,
      },
    },
  };
}

function setup() {
  const { bot, calls } = offlineBot();
  const feedback = inMemoryFeedback([1], () => NOW);
  const pending = inMemoryPending(() => NOW);
  registerFeedbackHandlers(bot, {
    feedback: feedback.store,
    activities: { byId: async (id) => (id === 1 ? ACTIVITY : null) },
    pending: pending.store,
    timeZone: "Europe/Ljubljana",
    now: () => NOW,
  });
  const payloads = (method: string) =>
    calls.filter((c) => c.method === method).map((c) => c.payload as Record<string, unknown>);
  return { bot, feedback, pending, payloads };
}

const FULL = feedbackKeyboard(1, ["rpe", "feel", "pain", "note"], null);

describe("feedbackKeyboard", () => {
  it("lays out the questions asked and marks the stored answers", async () => {
    expect(labels(FULL)).toEqual([
      ["1", "2", "3", "4", "5"],
      ["6", "7", "8", "9", "10"],
      ["😫", "😐", "🙂", "💪"],
      ["No pain", "Some pain"],
      ["📝 Add a note"],
    ]);
    const { store } = inMemoryFeedback([1]);
    const answered = await store.set(1, { rpe: 7, feel: "meh", pain: true });
    expect(labels(feedbackKeyboard(1, ["rpe", "feel", "pain"], answered))).toEqual([
      ["1", "2", "3", "4", "5"],
      ["6", "✓7", "8", "9", "10"],
      ["😫", "✓😐", "🙂", "💪"],
      ["No pain", "✓Some pain"],
    ]);
  });

  it("round-trips the questions through the sent buttons", () => {
    expect(questionsInKeyboard(FULL)).toEqual(["rpe", "feel", "pain", "note"]);
    expect(questionsInKeyboard(feedbackKeyboard(1, ["rpe", "note"], null))).toEqual([
      "rpe",
      "note",
    ]);
    expect(questionsInKeyboard(undefined)).toEqual([]);
  });
});

describe("feedbackText", () => {
  it("escapes the activity name and shows the answers so far", async () => {
    const { store } = inMemoryFeedback([1]);
    const answered = await store.set(1, { rpe: 4, rpeSource: "strava", note: "a < b" });
    const text = feedbackText(ACTIVITY, ["feel"], answered, "Europe/Ljubljana");
    expect(text).toContain("Tempo &lt;3&gt;");
    expect(text).not.toContain("Effort (RPE)"); // RPE wasn't asked
    expect(text).toContain("<b>Saved:</b> RPE 4 (from Strava)");
    expect(text).toContain("<b>Note:</b> <i>a &lt; b</i>");
  });
});

describe("registerFeedbackHandlers", () => {
  it("stores a tapped answer and redraws the message with the same questions", async () => {
    const { bot, feedback, payloads } = setup();
    await bot.handleUpdate(tap("fb:1:r:7", FULL));
    await bot.handleUpdate(tap("fb:1:f:good", FULL));

    expect(feedback.rows.get(1)).toMatchObject({ rpe: 7, rpeSource: "athlete", feel: "good" });
    const edit = payloads("editMessageText").at(-1);
    expect(edit?.text).toContain("RPE 7 · 🙂 good");
    expect(labels(edit?.reply_markup as InlineKeyboardMarkup)[1]).toContain("✓7");
    expect(labels(edit?.reply_markup as InlineKeyboardMarkup)).toHaveLength(5);
    expect(payloads("answerCallbackQuery").at(-1)).toMatchObject({ text: "Saved" });
  });

  it("opens a note after 'Some pain' and closes it again after 'No pain'", async () => {
    const { bot, feedback, pending, payloads } = setup();
    await bot.handleUpdate(tap("fb:1:p:y", FULL));
    expect(feedback.rows.get(1)?.pain).toBe(true);
    expect(pending.rows()).toMatchObject([
      { actionType: "activity_feedback", payload: { activityId: 1, field: "painNote" } },
    ]);
    expect(payloads("sendMessage").at(-1)?.text).toContain("Where does it hurt");

    await bot.handleUpdate(tap("fb:1:p:n", FULL));
    expect(feedback.rows.get(1)).toMatchObject({ pain: false, painNote: null });
    expect(pending.rows()).toEqual([]);
  });

  it("keeps a single open note: the latest tap wins", async () => {
    const { bot, pending } = setup();
    await bot.handleUpdate(tap("fb:1:p:y", FULL));
    await bot.handleUpdate(tap("fb:1:n:add", FULL));
    expect(pending.rows()).toMatchObject([{ payload: { activityId: 1, field: "note" } }]);
  });

  it("removes the buttons when the activity is gone", async () => {
    const { bot, feedback, payloads } = setup();
    await bot.handleUpdate(tap("fb:2:r:5", FULL));
    expect(feedback.rows.size).toBe(0);
    expect(payloads("answerCallbackQuery")[0]?.text).toContain("gone");
    expect(payloads("editMessageReplyMarkup")).toHaveLength(1);
  });

  it("ignores answers that aren't on the keyboard", async () => {
    const { bot, feedback, payloads } = setup();
    await bot.handleUpdate(tap("fb:1:r:11", FULL));
    await bot.handleUpdate(tap("fb:1:f:ecstatic", FULL));
    expect(feedback.rows.size).toBe(0);
    expect(payloads("editMessageText")).toEqual([]);
  });
});

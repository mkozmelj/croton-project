import { type Bot, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { type ActivityFeedbackPayload, FEEDBACK_NOTE_TTL_MS } from "../agent/actions.js";
import { formatDayTime } from "../agent/activity-format.js";
import { FEEDBACK_QUESTIONS, type FeedbackQuestion } from "../agent/feedback-questions.js";
import type { ActivityStore, ActivitySummary } from "../db/activities.js";
import type {
  ActivityFeedback,
  ActivityFeedbackStore,
  FeedbackFields,
} from "../db/activity-feedback.js";
import type { PendingActionStore } from "../db/pending-actions.js";
import { ACTIVITY_FEELS } from "../db/schema.js";
import { bold, esc, italic, sportEmoji } from "./html.js";

// ADR-018: one-tap questions after a new activity. A tap writes straight to
// activity_feedback (no model call) and redraws the message with the answers so far.

type Feel = (typeof ACTIVITY_FEELS)[number];

const FEEL_EMOJI: Record<Feel, string> = { awful: "😫", meh: "😐", good: "🙂", strong: "💪" };

// Callback data `fb:<activity id>:<question>:<answer>`, well under Telegram's 64 bytes.
const CODES: Record<FeedbackQuestion, string> = { rpe: "r", feel: "f", pain: "p", note: "n" };
const FEEDBACK_CALLBACK = /^fb:(\d+):([rfpn]):(\w+)$/;

const SELECTED = "✓";

export function feedbackKeyboard(
  activityId: number,
  questions: readonly FeedbackQuestion[],
  feedback: ActivityFeedback | null,
): InlineKeyboard {
  const data = (question: FeedbackQuestion, answer: string | number) =>
    `fb:${activityId}:${CODES[question]}:${answer}`;
  const button = (label: string, selected: boolean, data: string) =>
    InlineKeyboard.text(selected ? `${SELECTED}${label}` : label, data);
  const rows = [];
  if (questions.includes("rpe")) {
    for (const row of [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ]) {
      rows.push(row.map((rpe) => button(String(rpe), feedback?.rpe === rpe, data("rpe", rpe))));
    }
  }
  if (questions.includes("feel")) {
    rows.push(
      ACTIVITY_FEELS.map((feel) =>
        button(FEEL_EMOJI[feel], feedback?.feel === feel, data("feel", feel)),
      ),
    );
  }
  if (questions.includes("pain")) {
    rows.push([
      button("No pain", feedback?.pain === false, data("pain", "n")),
      button("Some pain", feedback?.pain === true, data("pain", "y")),
    ]);
  }
  if (questions.includes("note")) rows.push([button("📝 Add a note", false, data("note", "add"))]);
  return InlineKeyboard.from(rows);
}

// The questions a sent keyboard asks, read back from its buttons, so a redraw keeps them.
export function questionsInKeyboard(markup: InlineKeyboardMarkup | undefined): FeedbackQuestion[] {
  const codes = new Set(
    (markup?.inline_keyboard ?? []).flat().flatMap((button) => {
      const match = "callback_data" in button ? FEEDBACK_CALLBACK.exec(button.callback_data) : null;
      return match?.[2] ? [match[2]] : [];
    }),
  );
  return FEEDBACK_QUESTIONS.filter((question) => codes.has(CODES[question]));
}

export function feedbackText(
  activity: Pick<ActivitySummary, "sport" | "name" | "startedAt">,
  questions: readonly FeedbackQuestion[],
  feedback: ActivityFeedback | null,
  timeZone: string,
): string {
  const lines = [
    `💬 ${bold("How did it feel?")}`,
    `${sportEmoji(activity.sport)} ${esc(activity.name ?? activity.sport)} · ${esc(formatDayTime(activity.startedAt, timeZone))}`,
  ];
  if (questions.includes("rpe")) {
    lines.push(
      italic("Effort (RPE): 1 very easy, 3 easy chat pace, 5 steady, 7 hard, 10 all-out."),
    );
  }
  const answers = feedback ? answerLines(feedback) : [];
  if (answers.length > 0) lines.push("", ...answers);
  return lines.join("\n");
}

function answerLines(feedback: ActivityFeedback): string[] {
  const parts: string[] = [];
  if (feedback.rpe !== null) {
    parts.push(`RPE ${feedback.rpe}${feedback.rpeSource === "strava" ? " (from Strava)" : ""}`);
  }
  if (feedback.feel) parts.push(`${FEEL_EMOJI[feedback.feel]} ${feedback.feel}`);
  if (feedback.pain === false) parts.push("no pain");
  if (feedback.pain === true) parts.push("some pain");
  const lines = parts.length > 0 ? [`${bold("Saved:")} ${esc(parts.join(" · "))}`] : [];
  if (feedback.painNote) lines.push(`${bold("Pain:")} ${italic(feedback.painNote)}`);
  if (feedback.note) lines.push(`${bold("Note:")} ${italic(feedback.note)}`);
  return lines;
}

// A tap, parsed: what to write, and which note (if any) the next message becomes.
type Tap = {
  fields: FeedbackFields;
  note?: ActivityFeedbackPayload["field"];
  // "No pain" after "Some pain": the pain note asked for is no longer wanted.
  cancelsNote?: boolean;
};

function parseTap(code: string, answer: string): Tap | null {
  switch (code) {
    case "r": {
      const rpe = Number(answer);
      return Number.isInteger(rpe) && rpe >= 1 && rpe <= 10
        ? { fields: { rpe, rpeSource: "athlete" } }
        : null;
    }
    case "f": {
      const feel = ACTIVITY_FEELS.find((f) => f === answer);
      return feel ? { fields: { feel } } : null;
    }
    case "p":
      if (answer === "y") return { fields: { pain: true }, note: "painNote" };
      if (answer === "n") return { fields: { pain: false, painNote: null }, cancelsNote: true };
      return null;
    case "n":
      return { fields: {}, note: "note" };
    default:
      return null;
  }
}

const NOTE_PROMPTS: Record<ActivityFeedbackPayload["field"], string> = {
  painNote:
    "🩹 Where does it hurt, and how bad (e.g. <i>left calf, tight after 5 km, 3/10</i>)? Your next message is saved with this activity.",
  note: "📝 What would you like to add? Your next message is saved with this activity.",
};

export type FeedbackHandlerDeps = {
  feedback: Pick<ActivityFeedbackStore, "set" | "get">;
  activities: Pick<ActivityStore, "byId">;
  pending: Pick<PendingActionStore, "create" | "clear">;
  timeZone: string;
  now?: () => Date;
};

export function registerFeedbackHandlers(bot: Bot, deps: FeedbackHandlerDeps): void {
  const now = deps.now ?? (() => new Date());

  bot.callbackQuery(FEEDBACK_CALLBACK, async (ctx) => {
    const chatId = ctx.chat?.id;
    const activityId = Number(ctx.match[1]);
    const tap = parseTap(ctx.match[2] ?? "", ctx.match[3] ?? "");
    if (chatId === undefined || !tap) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    const stored =
      Object.keys(tap.fields).length > 0
        ? await deps.feedback.set(activityId, tap.fields)
        : await deps.feedback.get(activityId);
    const activity = await deps.activities.byId(activityId);
    if (!activity) {
      await ctx
        .answerCallbackQuery({ text: "That activity is gone (deleted on Strava?)." })
        .catch(() => {});
      await ctx.editMessageReplyMarkup().catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery(tap.note ? {} : { text: "Saved" }).catch(() => {
      // Only stops the button's loading spinner.
    });

    const questions = questionsInKeyboard(ctx.callbackQuery.message?.reply_markup);
    await ctx
      .editMessageText(feedbackText(activity, questions, stored, deps.timeZone), {
        reply_markup: feedbackKeyboard(activityId, questions, stored),
      })
      .catch(() => {
        // "Message is not modified" (the same answer tapped twice) or too old to edit.
      });

    // One open note at a time: the latest tap wins.
    if (tap.note || tap.cancelsNote) await deps.pending.clear(chatId, ["activity_feedback"]);
    if (tap.note) {
      const payload: ActivityFeedbackPayload = { activityId, field: tap.note };
      await deps.pending.create({
        chatId,
        actionType: "activity_feedback",
        payload,
        expiresAt: new Date(now().getTime() + FEEDBACK_NOTE_TTL_MS),
      });
      await ctx.reply(NOTE_PROMPTS[tap.note]);
    }
  });
}

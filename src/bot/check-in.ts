import { type Bot, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { dayLabel } from "../agent/plan-format.js";
import type { PlannedWorkoutRow, PlannedWorkoutStore } from "../db/planned-workouts.js";
import {
  CHECK_IN_ANSWERS,
  type CheckInAnswer,
  type TrainingPlanStore,
} from "../db/training-plans.js";
import { localDate } from "../utils/dates.js";
import { esc } from "../utils/html.js";
import { bold, italic, sportEmoji } from "./html.js";

// ADR-021 morning check-in: one message lists the past sessions no activity matched, each with
// Done / Partly / Skipped. A tap writes the status straight to planned_workouts (no model call,
// no pending action, like ADR-018) and redraws the message from the stored statuses.

// Callback data `pw:<session id>:<answer>`, well under Telegram's 64 bytes.
const CHECK_IN_CALLBACK = /^pw:(\d+):(done|partial|skipped)$/;

const LABELS: Record<CheckInAnswer, string> = {
  done: "Done",
  partial: "Partly",
  skipped: "Skipped",
};

const SELECTED = "✓";

type Session = Pick<
  PlannedWorkoutRow,
  "id" | "date" | "sport" | "title" | "activeMinutes" | "status" | "statusSource"
>;

const isAnswer = (status: string): status is CheckInAnswer =>
  CHECK_IN_ANSWERS.some((answer) => answer === status);

export function checkInKeyboard(sessions: readonly Session[]): InlineKeyboard {
  const numbered = sessions.length > 1;
  return InlineKeyboard.from(
    sessions.map((session, i) =>
      CHECK_IN_ANSWERS.map((answer) => {
        const label = `${numbered ? `${i + 1}: ` : ""}${LABELS[answer]}`;
        return InlineKeyboard.text(
          session.status === answer ? `${SELECTED}${label}` : label,
          `pw:${session.id}:${answer}`,
        );
      }),
    ),
  );
}

// The session ids a sent keyboard asks about, in order, read back from its buttons.
export function sessionIdsInKeyboard(markup: InlineKeyboardMarkup | undefined): number[] {
  const ids: number[] = [];
  for (const button of (markup?.inline_keyboard ?? []).flat()) {
    const match = "callback_data" in button ? CHECK_IN_CALLBACK.exec(button.callback_data) : null;
    const id = Number(match?.[1]);
    if (match && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function checkInText(sessions: readonly Session[]): string {
  const numbered = sessions.length > 1;
  const lines = sessions.map((session, i) => {
    const head = `${numbered ? `${i + 1}. ` : ""}${sportEmoji(session.sport)} ${esc(dayLabel(session.date))} · ${esc(session.title)} · ${session.activeMinutes} min`;
    const state = stateNote(session);
    return state ? `${head}\n   ${state}` : head;
  });
  return [
    `☀️ ${bold(numbered ? "How did these go?" : "How did this one go?")}`,
    italic(
      `No Strava activity matched ${numbered ? "them" : "it"}. Your answer counts in the completion rate.`,
    ),
    "",
    ...lines,
  ].join("\n");
}

function stateNote(session: Session): string | null {
  if (session.statusSource === "match") return italic("✅ A Strava activity counts for it now.");
  if (session.status === "replaced") return italic("Replaced by a plan change.");
  if (session.statusSource === "timeout") return italic("Counted as skipped: no answer in time.");
  return null;
}

export type CheckInHandlerDeps = {
  plans: Pick<TrainingPlanStore, "setAnswer">;
  sessions: Pick<PlannedWorkoutStore, "byId">;
  timeZone: string;
  now?: () => Date;
};

export function registerCheckInHandlers(bot: Bot, deps: CheckInHandlerDeps): void {
  const now = deps.now ?? (() => new Date());

  bot.callbackQuery(CHECK_IN_CALLBACK, async (ctx) => {
    const id = Number(ctx.match[1]);
    const answer = ctx.match[2] ?? "";
    if (!isAnswer(answer)) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const saved = await deps.plans.setAnswer(id, answer, localDate(now(), deps.timeZone));
    await ctx
      .answerCallbackQuery({
        text: saved ? "Saved" : "Not changed: a Strava activity or a plan change decides this one.",
      })
      .catch(() => {
        // Only stops the button's loading spinner.
      });

    const ids = sessionIdsInKeyboard(ctx.callbackQuery.message?.reply_markup);
    const records = await Promise.all(ids.map((sessionId) => deps.sessions.byId(sessionId)));
    const sessions = records.flatMap((record) => (record ? [record.session] : []));
    if (sessions.length === 0) {
      await ctx.editMessageReplyMarkup().catch(() => {});
      return;
    }
    await ctx
      .editMessageText(checkInText(sessions), { reply_markup: checkInKeyboard(sessions) })
      .catch(() => {
        // "Message is not modified" (the same answer tapped twice) or too old to edit.
      });
  });
}

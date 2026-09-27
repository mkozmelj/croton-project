import type { Api, InlineKeyboard } from "grammy";
import type { Logger } from "pino";
import type { PendingActionRow } from "../db/pending-actions.js";
import { proposalMessages } from "./handlers.js";
import { splitMessage } from "./html.js";

export type Notifier = {
  // Sends a message (Telegram HTML, ADR-017) to the athlete. Never throws: a failed alert is logged, not re-raised,
  // so it can't mask the error that triggered it.
  notify(text: string): Promise<void>;
  // Sends one message with inline buttons (e.g. the activity feedback questions). Never throws.
  notifyWithButtons(text: string, keyboard: InlineKeyboard): Promise<void>;
  // Sends a proposal with its Confirm/Cancel buttons (e.g. a field-test marker). Never throws.
  propose(row: PendingActionRow): Promise<void>;
};

export function createNotifier(
  api: Pick<Api, "sendMessage">,
  chatId: number,
  logger: Logger,
): Notifier {
  const log = logger.child({ module: "notifier" });
  return {
    async notify(text) {
      try {
        for (const chunk of splitMessage(text)) await api.sendMessage(chatId, chunk);
      } catch (error) {
        log.error({ err: error }, "failed to send Telegram notification");
      }
    },

    async notifyWithButtons(text, keyboard) {
      try {
        await api.sendMessage(chatId, text, { reply_markup: keyboard });
      } catch (error) {
        log.error({ err: error }, "failed to send Telegram message with buttons");
      }
    },

    async propose(row) {
      try {
        for (const { text, ...options } of proposalMessages(row)) {
          await api.sendMessage(chatId, text, options);
        }
      } catch (error) {
        log.error({ err: error }, "failed to send Telegram proposal");
      }
    },
  };
}

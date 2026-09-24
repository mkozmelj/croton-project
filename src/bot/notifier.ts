import type { Api } from "grammy";
import type { Logger } from "pino";
import { splitMessage } from "./formatting.js";

export type Notifier = {
  // Sends a message to the athlete. Never throws: a failed alert is logged, not re-raised,
  // so it can't mask the error that triggered it.
  notify(text: string): Promise<void>;
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
  };
}

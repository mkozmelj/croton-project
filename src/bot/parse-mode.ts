import type { Transformer } from "grammy";
import type { Logger } from "pino";
import { stripHtml } from "./html.js";

type TextPayload = { text: string; parse_mode?: string };

// Methods whose `text` is a message body. An edit (e.g. the feedback redraw) needs the mode as
// much as the first send, or the tags show up literally.
const TEXT_METHODS: ReadonlySet<string> = new Set(["sendMessage", "editMessageText"]);

// ADR-017: every message text is Telegram HTML unless it sets its own parse_mode. Installed on
// bot.api, so replies, edits and notifier messages alike get it. Should Telegram still reject the
// markup, the message goes again as plain text: a formatting bug never swallows a reply.
export function htmlParseMode(logger: Logger): Transformer {
  const log = logger.child({ module: "bot" });
  return async (prev, method, payload, signal) => {
    if (!TEXT_METHODS.has(method)) return prev(method, payload, signal);
    const message = payload as typeof payload & TextPayload;
    if (message.parse_mode !== undefined) return prev(method, payload, signal);

    const result = await prev(method, { ...payload, parse_mode: "HTML" }, signal);
    if (
      result.ok ||
      result.error_code !== 400 ||
      !/can't parse entities/i.test(result.description)
    ) {
      return result;
    }
    log.warn({ description: result.description }, "Telegram rejected the HTML, sending plain text");
    return prev(method, { ...payload, text: stripHtml(message.text) }, signal);
  };
}

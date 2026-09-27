import type { ApiCallFn } from "grammy";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { htmlParseMode } from "./parse-mode.js";

type Sent = { method: string; payload: Record<string, unknown> };

// A fake API call that answers every sendMessage with `responses` in turn.
function fakeApi(responses: unknown[]) {
  const sent: Sent[] = [];
  const prev = (async (method: string, payload: Record<string, unknown>) => {
    sent.push({ method, payload });
    return responses.shift() ?? { ok: true, result: true };
  }) as unknown as ApiCallFn;
  return { prev, sent };
}

const transformer = htmlParseMode(pino({ level: "silent" }));
const send = (prev: ApiCallFn, payload: Record<string, unknown>, method = "sendMessage") =>
  transformer(prev, method as "sendMessage", payload as never);

describe("htmlParseMode", () => {
  it("sends messages as HTML", async () => {
    const { prev, sent } = fakeApi([]);
    await send(prev, { chat_id: 1, text: "<b>Hi</b>" });
    expect(sent).toEqual([
      { method: "sendMessage", payload: { chat_id: 1, text: "<b>Hi</b>", parse_mode: "HTML" } },
    ]);
  });

  it("resends as plain text when Telegram rejects the markup", async () => {
    const { prev, sent } = fakeApi([
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities: x" },
    ]);
    const result = await send(prev, { chat_id: 1, text: "<b>FTP</b> &lt;250" });
    expect(result.ok).toBe(true);
    expect(sent[1]?.payload).toEqual({ chat_id: 1, text: "FTP <250" });
  });

  it("sets HTML on message edits too", async () => {
    const { prev, sent } = fakeApi([]);
    await send(prev, { chat_id: 1, message_id: 2, text: "<b>Saved</b>" }, "editMessageText");
    expect(sent[0]?.payload.parse_mode).toBe("HTML");
  });

  it("doesn't retry other errors, and leaves other methods and explicit modes alone", async () => {
    const { prev, sent } = fakeApi([{ ok: false, error_code: 403, description: "blocked" }]);
    expect((await send(prev, { chat_id: 1, text: "x" })).ok).toBe(false);
    await send(prev, { chat_id: 1, text: "x", parse_mode: "MarkdownV2" });
    await send(prev, { chat_id: 1, action: "typing" }, "sendChatAction");
    expect(sent.map((s) => s.payload.parse_mode)).toEqual(["HTML", "MarkdownV2", undefined]);
  });
});

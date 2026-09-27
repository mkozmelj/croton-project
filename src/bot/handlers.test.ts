import type { Update } from "grammy/types";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { ActionExecutor } from "../agent/action-executor.js";
import type { IncomingMessage } from "../agent/orchestrator.js";
import { GoogleAuthError } from "../integrations/google/oauth.js";
import { authorizedChatOnly } from "./access-control.js";
import { errorBoundary, registerMessageHandlers } from "./handlers.js";
import { offlineBot } from "./test-helpers.js";

const CHAT = 1001;

function tap(chatId: number, data: string): Update {
  return {
    update_id: 5,
    callback_query: {
      id: "cb1",
      chat_instance: "ci",
      from: { id: chatId, is_bot: false, first_name: "Athlete" },
      data,
      message: {
        message_id: 77,
        date: 0,
        chat: { id: chatId, type: "private", first_name: "Athlete" },
        text: "Proposed plan",
      },
    },
  };
}

function setup(confirm: ActionExecutor["confirm"]) {
  const { bot, calls } = offlineBot();
  const confirmed: [number, number][] = [];
  const handled: IncomingMessage[] = [];
  const logger = pino({ level: "silent" });
  bot.use(errorBoundary(logger));
  bot.use(authorizedChatOnly(CHAT, logger));
  registerMessageHandlers(bot, {
    orchestrator: {
      handleMessage: async (incoming) => {
        handled.push(incoming);
        return { text: "answer", proposals: [] };
      },
      startOnboarding: async () => {},
    },
    executor: {
      confirm: async (id, chatId) => {
        confirmed.push([id, chatId]);
        return confirm(id, chatId);
      },
      cancel: async () => "Cancelled, nothing was saved.",
    },
  });
  const sent = () =>
    calls
      .filter((c) => c.method === "sendMessage")
      .map((c) => (c.payload as { text: string }).text);
  const methods = () => calls.map((c) => c.method);
  return { bot, confirmed, handled, sent, methods };
}

function command(chatId: number, text: string): Update {
  const length = text.split(" ")[0]?.length ?? 0;
  return {
    update_id: 6,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "Athlete" },
      from: { id: chatId, is_bot: false, first_name: "Athlete" },
      text,
      entities: [{ type: "bot_command", offset: 0, length }],
    },
  };
}

describe("/deep", () => {
  it("sends the question without the command, with Sonnet forced", async () => {
    const { bot, handled, sent } = setup(async () => "x");
    await bot.handleUpdate(command(CHAT, "/deep am I ready for a 70.3?"));
    expect(handled).toEqual([
      { text: "am I ready for a 70.3?", telegramMessageId: 11, deep: true },
    ]);
    expect(sent()).toContain("answer");
  });

  it("explains itself when sent without a question", async () => {
    const { bot, handled, sent } = setup(async () => "x");
    await bot.handleUpdate(command(CHAT, "/deep"));
    expect(handled).toEqual([]);
    expect(sent()[0]).toMatch(/^Send \/deep followed by/);
  });
});

describe("proposal buttons", () => {
  it("confirms, removes the buttons, and reports the result", async () => {
    const { bot, confirmed, sent, methods } = setup(async () => "Plan saved.");
    await bot.handleUpdate(tap(CHAT, "pa:12:ok"));
    expect(confirmed).toEqual([[12, CHAT]]);
    expect(methods()).toContain("answerCallbackQuery");
    expect(methods()).toContain("editMessageReplyMarkup");
    expect(sent()).toContain("Plan saved.");
  });

  it("keeps the buttons when the calendar token has expired", async () => {
    const { bot, sent, methods } = setup(async () => {
      throw new GoogleAuthError("expired");
    });
    await bot.handleUpdate(tap(CHAT, "pa:12:ok"));
    expect(methods()).not.toContain("editMessageReplyMarkup");
    expect(sent()[0]).toContain("/reauth calendar");
  });

  it("drops taps from any other chat", async () => {
    const { bot, confirmed, methods } = setup(async () => "x");
    await bot.handleUpdate(tap(999, "pa:12:ok"));
    expect(confirmed).toEqual([]);
    expect(methods()).toEqual([]);
  });
});

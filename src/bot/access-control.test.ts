import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { authorizedChatOnly } from "./access-control.js";
import { offlineBot, textUpdate } from "./test-helpers.js";

const AUTHORIZED = 1000;

function botWithEcho() {
  const { bot, calls } = offlineBot();
  bot.use(authorizedChatOnly(AUTHORIZED, pino({ level: "silent" })));
  bot.on("message:text", (ctx) => ctx.reply("pong"));
  return { bot, calls };
}

describe("authorizedChatOnly", () => {
  it("lets the authorized chat through", async () => {
    const { bot, calls } = botWithEcho();
    await bot.handleUpdate(textUpdate(AUTHORIZED, "ping"));
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  });

  it("silently drops every other chat", async () => {
    const { bot, calls } = botWithEcho();
    await bot.handleUpdate(textUpdate(2000, "ping"));
    expect(calls).toEqual([]);
  });
});

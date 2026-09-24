import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { TELEGRAM_WEBHOOK_PATH } from "./setup.js";
import { offlineBot, textUpdate } from "./test-helpers.js";
import { registerTelegramWebhook } from "./webhook.js";

const SECRET = "test-webhook-secret-0123456789";

function setup() {
  const { bot, calls } = offlineBot();
  const seen: number[] = [];
  bot.on("message", (ctx) => {
    seen.push(ctx.update.update_id);
  });
  const app = buildServer({ logger: pino({ level: "silent" }) });
  registerTelegramWebhook(app, { bot, secretToken: SECRET });
  return { app, seen, calls };
}

describe(`POST ${TELEGRAM_WEBHOOK_PATH}`, () => {
  it("passes an update with the right secret to the bot", async () => {
    const { app, seen } = setup();
    const response = await app.inject({
      method: "POST",
      url: TELEGRAM_WEBHOOK_PATH,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: textUpdate(1000, "hi", 42),
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([42]);
  });

  it.each([
    ["a wrong secret", { "x-telegram-bot-api-secret-token": "wrong" }],
    ["no secret", {}],
  ])("rejects %s with an empty 401", async (_label, headers) => {
    const { app, seen } = setup();
    const response = await app.inject({
      method: "POST",
      url: TELEGRAM_WEBHOOK_PATH,
      headers,
      payload: textUpdate(1000, "hi"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("");
    expect(seen).toEqual([]);
  });

  it("rejects before parsing the body", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: TELEGRAM_WEBHOOK_PATH,
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(401);
  });
});

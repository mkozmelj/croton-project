import type { FastifyInstance } from "fastify";
import { type Bot, webhookCallback } from "grammy";
import { secureEquals } from "../utils/secure-compare.js";
import { TELEGRAM_WEBHOOK_PATH } from "./setup.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

// Claude calls can outlast Telegram's patience. After this long, answer 200 and let the
// handler finish in the background rather than have Telegram redeliver the update.
const WEBHOOK_TIMEOUT_MS = 8_000;

export function registerTelegramWebhook(
  app: FastifyInstance,
  { bot, secretToken }: { bot: Bot; secretToken: string },
): void {
  const handleUpdate = webhookCallback(bot, "fastify", {
    onTimeout: "return",
    timeoutMilliseconds: WEBHOOK_TIMEOUT_MS,
  });

  app.post(TELEGRAM_WEBHOOK_PATH, {
    // ADR-012: authenticate in onRequest, which runs before Fastify parses the body.
    onRequest: async (request, reply) => {
      if (!secureEquals(request.headers[SECRET_HEADER], secretToken)) {
        request.log.warn({ module: "telegram-webhook" }, "rejected webhook with bad secret");
        return reply.code(401).send();
      }
    },
    handler: handleUpdate,
  });
}

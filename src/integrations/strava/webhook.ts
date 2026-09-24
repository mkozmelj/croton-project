import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { secureEquals } from "../../utils/secure-compare.js";

export const STRAVA_WEBHOOK_PATH = "/webhook/strava";

const handshakeQuery = z.object({
  "hub.mode": z.literal("subscribe"),
  "hub.challenge": z.string().min(1),
  "hub.verify_token": z.string(),
});

export const stravaEventSchema = z.object({
  object_type: z.enum(["activity", "athlete"]),
  object_id: z.number().int(),
  aspect_type: z.enum(["create", "update", "delete"]),
  owner_id: z.number().int(),
  subscription_id: z.number().int(),
  event_time: z.number().int(),
  updates: z.record(z.string(), z.unknown()).optional(),
});

export type StravaEvent = z.infer<typeof stravaEventSchema>;

type WebhookDeps = {
  verifyToken: string;
  // Unset until `npm run strava:subscribe` has run — every event is rejected until then.
  subscriptionId: number | undefined;
  // The connected athlete's Strava id; null while Strava isn't connected.
  athleteId: () => Promise<string | null>;
  // Called after the 200 is sent; must not throw into the request (use BackgroundTasks).
  onEvent: (event: StravaEvent) => void;
};

// ADR-012: Strava doesn't sign events. The handshake is checked against the verify token;
// events are accepted only for our subscription and our athlete, and the activity itself
// is re-fetched from the API instead of trusting the payload.
export function registerStravaWebhook(app: FastifyInstance, deps: WebhookDeps): void {
  // The handshake query carries the verify token: keep it out of the request log.
  app.get(STRAVA_WEBHOOK_PATH, { logLevel: "warn" }, async (request, reply) => {
    const query = handshakeQuery.safeParse(request.query);
    if (!query.success || !secureEquals(query.data["hub.verify_token"], deps.verifyToken)) {
      request.log.warn({ module: "strava-webhook" }, "rejected subscription handshake");
      return reply.code(401).send();
    }
    return { "hub.challenge": query.data["hub.challenge"] };
  });

  app.post(STRAVA_WEBHOOK_PATH, async (request, reply) => {
    const parsed = stravaEventSchema.safeParse(request.body);
    const athleteId = parsed.success ? await deps.athleteId() : null;
    if (
      !parsed.success ||
      deps.subscriptionId === undefined ||
      parsed.data.subscription_id !== deps.subscriptionId ||
      athleteId === null ||
      String(parsed.data.owner_id) !== athleteId
    ) {
      request.log.warn({ module: "strava-webhook" }, "rejected webhook event");
      return reply.code(401).send();
    }

    deps.onEvent(parsed.data);
    return reply.code(200).send();
  });
}

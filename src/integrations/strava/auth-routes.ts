import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OAuthStateStore } from "../../db/oauth-states.js";
import { hasActivityScope, type StravaAuth } from "./oauth.js";

export const STRAVA_AUTH_START_PATH = "/auth/strava/start";
export const STRAVA_AUTH_CALLBACK_PATH = "/auth/strava/callback";

const startQuery = z.object({ state: z.string().min(1) });
const callbackQuery = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
});

type AuthRouteDeps = {
  auth: StravaAuth;
  states: OAuthStateStore;
  // Tells the athlete in Telegram how the connection went.
  onConnected: (athleteId: string) => Promise<void>;
};

const EXPIRED =
  "This link has expired or was already used. Send /connect in Telegram for a new one.";

// ADR-011: both routes need a live single-use `state` minted by the bot's /connect command,
// so nobody who finds the URL can link their own Strava account.
export function registerStravaAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.get(STRAVA_AUTH_START_PATH, async (request, reply) => {
    const query = startQuery.safeParse(request.query);
    if (!query.success || !(await deps.states.isLive(query.data.state, "strava"))) {
      return reply.code(400).type("text/plain").send(EXPIRED);
    }
    return reply.redirect(deps.auth.authorizeUrl(query.data.state));
  });

  // The query carries the one-time authorization code: keep it out of the request log.
  app.get(STRAVA_AUTH_CALLBACK_PATH, { logLevel: "warn" }, async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    if (!query.success || !(await deps.states.consume(query.data.state, "strava"))) {
      request.log.warn({ module: "strava-auth" }, "rejected OAuth callback with unknown state");
      return reply.code(400).type("text/plain").send(EXPIRED);
    }
    const { code, scope = "", error } = query.data;
    if (error || !code) {
      return reply
        .code(400)
        .type("text/plain")
        .send("Strava access was not granted. Send /connect in Telegram to try again.");
    }
    if (!hasActivityScope(scope)) {
      return reply
        .code(400)
        .type("text/plain")
        .send(
          "Activity access is needed. Send /connect in Telegram and leave the activity boxes ticked.",
        );
    }

    const athleteId = await deps.auth.exchangeCode(code, scope);
    request.log.info({ module: "strava-auth", scope }, "strava connected");
    await deps.onConnected(athleteId);
    return reply.type("text/plain").send("Strava connected. You can close this tab.");
  });
}

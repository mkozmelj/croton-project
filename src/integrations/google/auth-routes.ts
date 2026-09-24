import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OAuthStateStore } from "../../db/oauth-states.js";
import { type GoogleAuth, GoogleAuthError } from "./oauth.js";

export const GOOGLE_AUTH_START_PATH = "/auth/google/start";
export const GOOGLE_AUTH_CALLBACK_PATH = "/auth/google/callback";

const startQuery = z.object({ state: z.string().min(1) });
const callbackQuery = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  error: z.string().optional(),
});

type AuthRouteDeps = {
  auth: GoogleAuth;
  states: OAuthStateStore;
  onConnected: () => Promise<void>;
};

const EXPIRED =
  "This link has expired or was already used. Send /connect calendar in Telegram for a new one.";

// ADR-011: same single-use `state` rules as the Strava routes.
export function registerGoogleAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.get(GOOGLE_AUTH_START_PATH, async (request, reply) => {
    const query = startQuery.safeParse(request.query);
    if (!query.success || !(await deps.states.isLive(query.data.state, "google"))) {
      return reply.code(400).type("text/plain").send(EXPIRED);
    }
    return reply.redirect(deps.auth.authorizeUrl(query.data.state));
  });

  // The query carries the one-time authorization code: keep it out of the request log.
  app.get(GOOGLE_AUTH_CALLBACK_PATH, { logLevel: "warn" }, async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    if (!query.success || !(await deps.states.consume(query.data.state, "google"))) {
      request.log.warn({ module: "google-auth" }, "rejected OAuth callback with unknown state");
      return reply.code(400).type("text/plain").send(EXPIRED);
    }
    const { code, error } = query.data;
    if (error || !code) {
      return reply
        .code(400)
        .type("text/plain")
        .send("Calendar access was not granted. Send /connect calendar in Telegram to try again.");
    }

    try {
      await deps.auth.exchangeCode(code);
    } catch (exchangeError) {
      if (!(exchangeError instanceof GoogleAuthError)) throw exchangeError;
      return reply
        .code(400)
        .type("text/plain")
        .send(
          "Calendar access is needed. Send /connect calendar in Telegram and leave the calendar box ticked.",
        );
    }
    request.log.info({ module: "google-auth" }, "google calendar connected");
    await deps.onConnected();
    return reply.type("text/plain").send("Google Calendar connected. You can close this tab.");
  });
}

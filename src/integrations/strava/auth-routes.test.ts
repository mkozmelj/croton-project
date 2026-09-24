import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { OAuthStateStore } from "../../db/oauth-states.js";
import { buildServer } from "../../server.js";
import {
  registerStravaAuthRoutes,
  STRAVA_AUTH_CALLBACK_PATH,
  STRAVA_AUTH_START_PATH,
} from "./auth-routes.js";
import type { StravaAuth } from "./oauth.js";

function setup() {
  const live = new Set(["good-state"]);
  const states: OAuthStateStore = {
    create: async () => "unused",
    isLive: async (state) => live.has(state),
    consume: async (state) => live.delete(state),
  };
  const exchanged: string[] = [];
  const connected: string[] = [];
  const auth: StravaAuth = {
    authorizeUrl: (state) => `https://www.strava.com/oauth/authorize?state=${state}`,
    exchangeCode: async (code) => {
      exchanged.push(code);
      return "4242";
    },
    accessToken: async () => "unused",
    athleteId: async () => null,
  };
  const app = buildServer({ logger: pino({ level: "silent" }) });
  registerStravaAuthRoutes(app, {
    auth,
    states,
    onConnected: async (athleteId) => {
      connected.push(athleteId);
    },
  });
  return { app, exchanged, connected };
}

const callback = (query: string) => `${STRAVA_AUTH_CALLBACK_PATH}?${query}`;

describe("Strava OAuth routes", () => {
  it("redirects a live state to Strava", async () => {
    const { app } = setup();
    const response = await app.inject({ url: `${STRAVA_AUTH_START_PATH}?state=good-state` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("state=good-state");
  });

  it("refuses to start without a live state", async () => {
    const { app } = setup();
    expect((await app.inject({ url: `${STRAVA_AUTH_START_PATH}?state=nope` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: STRAVA_AUTH_START_PATH })).statusCode).toBe(400);
  });

  it("exchanges the code once and reports the connection", async () => {
    const { app, exchanged, connected } = setup();
    const url = callback("state=good-state&code=fake-code&scope=read,activity:read_all");
    expect((await app.inject({ url })).statusCode).toBe(200);
    expect(exchanged).toEqual(["fake-code"]);
    expect(connected).toEqual(["4242"]);

    // Single-use: replaying the same callback fails.
    expect((await app.inject({ url })).statusCode).toBe(400);
    expect(exchanged).toHaveLength(1);
  });

  it("rejects an unknown state without exchanging the code", async () => {
    const { app, exchanged } = setup();
    const response = await app.inject({ url: callback("state=forged&code=fake-code&scope=read") });
    expect(response.statusCode).toBe(400);
    expect(exchanged).toEqual([]);
  });

  it("rejects a grant without activity access", async () => {
    const { app, exchanged } = setup();
    const response = await app.inject({
      url: callback("state=good-state&code=fake-code&scope=read"),
    });
    expect(response.statusCode).toBe(400);
    expect(exchanged).toEqual([]);
  });

  it("handles the athlete declining", async () => {
    const { app, exchanged } = setup();
    const response = await app.inject({ url: callback("state=good-state&error=access_denied") });
    expect(response.statusCode).toBe(400);
    expect(exchanged).toEqual([]);
  });
});

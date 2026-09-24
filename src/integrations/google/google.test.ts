import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { OAuthStateStore } from "../../db/oauth-states.js";
import { buildServer } from "../../server.js";
import { inMemoryTokens } from "../strava/test-fixtures.js";
import {
  GOOGLE_AUTH_CALLBACK_PATH,
  GOOGLE_AUTH_START_PATH,
  registerGoogleAuthRoutes,
} from "./auth-routes.js";
import { createCalendarClient, type EventBody } from "./calendar.js";
import {
  createGoogleAuth,
  GOOGLE_CALENDAR_SCOPE,
  type GoogleAuth,
  GoogleAuthError,
} from "./oauth.js";
import { addMinutesLocal, workoutEventId } from "./plan-events.js";

// Fake credentials only (ADR-013).
const NOW = new Date("2026-09-24T10:00:00Z");

function fakeFetch(responses: Response[]) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }) as typeof fetch;
  return { doFetch, requests };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createGoogleAuth", () => {
  it("refreshes near expiry and keeps the stored refresh token when none is returned", async () => {
    const tokens = inMemoryTokens({
      accountId: null,
      accessToken: "old-access",
      refreshToken: "refresh-1",
      expiresAt: new Date(NOW.getTime() + 60_000),
      scope: GOOGLE_CALENDAR_SCOPE,
    });
    const { doFetch, requests } = fakeFetch([
      json({ access_token: "new-access", expires_in: 3599 }),
    ]);
    const auth = createGoogleAuth({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "http://localhost/cb",
      tokens: tokens.store,
      fetch: doFetch,
      now: () => NOW,
    });

    expect(await auth.accessToken()).toBe("new-access");
    expect(String(requests[0]?.init?.body)).toContain("grant_type=refresh_token");
    expect(tokens.current()).toMatchObject({
      accessToken: "new-access",
      refreshToken: "refresh-1",
    });
  });

  it("turns a rejected refresh into GoogleAuthError", async () => {
    const tokens = inMemoryTokens({
      accountId: null,
      accessToken: "a",
      refreshToken: "r",
      expiresAt: NOW,
      scope: null,
    });
    const auth = createGoogleAuth({
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost/cb",
      tokens: tokens.store,
      fetch: fakeFetch([json({ error: "invalid_grant" }, 400)]).doFetch,
      now: () => NOW,
    });
    await expect(auth.accessToken()).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it("asks for offline access and forced consent, so a refresh token comes back", () => {
    const auth = createGoogleAuth({
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost/cb",
      tokens: inMemoryTokens().store,
    });
    const url = new URL(auth.authorizeUrl("st"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPE);
  });
});

describe("Google OAuth routes", () => {
  function setup(exchange: () => Promise<void> = async () => {}) {
    const live = new Set(["good-state"]);
    const states: OAuthStateStore = {
      create: async () => "unused",
      isLive: async (state) => live.has(state),
      consume: async (state) => live.delete(state),
    };
    let connected = 0;
    const auth: GoogleAuth = {
      authorizeUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchangeCode: exchange,
      accessToken: async () => "unused",
      isConnected: async () => false,
    };
    const app = buildServer({ logger: pino({ level: "silent" }) });
    registerGoogleAuthRoutes(app, {
      auth,
      states,
      onConnected: async () => {
        connected++;
      },
    });
    return { app, connected: () => connected };
  }

  it("rejects an unknown or replayed state", async () => {
    const { app, connected } = setup();
    expect((await app.inject(`${GOOGLE_AUTH_START_PATH}?state=nope`)).statusCode).toBe(400);
    const first = await app.inject(`${GOOGLE_AUTH_CALLBACK_PATH}?state=good-state&code=c`);
    expect(first.statusCode).toBe(200);
    const replay = await app.inject(`${GOOGLE_AUTH_CALLBACK_PATH}?state=good-state&code=c`);
    expect(replay.statusCode).toBe(400);
    expect(connected()).toBe(1);
  });

  it("explains a grant without calendar access", async () => {
    const { app, connected } = setup(async () => {
      throw new GoogleAuthError("Calendar access was not granted");
    });
    const response = await app.inject(`${GOOGLE_AUTH_CALLBACK_PATH}?state=good-state&code=c`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("leave the calendar box ticked");
    expect(connected()).toBe(0);
  });
});

describe("createCalendarClient", () => {
  const body = { summary: "Run" } as EventBody;
  const auth = { accessToken: async () => "token" };

  it("replaces an existing event id instead of failing (idempotent retry)", async () => {
    const { doFetch, requests } = fakeFetch([json({}, 409), json({})]);
    await createCalendarClient({ auth, fetch: doFetch }).upsertEvent("crotonabc12", body);
    expect(requests.map((r) => r.init?.method)).toEqual(["POST", "PUT"]);
    expect(requests[1]?.url).toMatch(/\/events\/crotonabc12$/);
  });

  it("treats deleting an already-deleted event as done", async () => {
    const { doFetch } = fakeFetch([new Response(null, { status: 410 })]);
    await expect(
      createCalendarClient({ auth, fetch: doFetch }).deleteEvent("x1234"),
    ).resolves.toBeUndefined();
  });
});

describe("plan events", () => {
  it("adds minutes to a naive local time, across midnight", () => {
    expect(addMinutesLocal("2026-09-29", "07:00", 55)).toBe("2026-09-29T07:55:00");
    expect(addMinutesLocal("2026-09-29", "23:30", 45)).toBe("2026-09-30T00:15:00");
  });

  it("makes valid, deterministic event ids", () => {
    expect(workoutEventId("plan-1", 0)).toBe(workoutEventId("plan-1", 0));
    expect(workoutEventId("plan-1", 0)).not.toBe(workoutEventId("plan-1", 1));
    expect(workoutEventId("plan-1", 0)).toMatch(/^[0-9a-v]+$/);
  });
});

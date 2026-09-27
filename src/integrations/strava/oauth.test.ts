import { describe, expect, it } from "vitest";
import { TokenRefreshError } from "../token-refresh.js";
import { createStravaAuth, hasActivityScope, hasWriteScope, StravaAuthError } from "./oauth.js";
import { inMemoryTokens } from "./test-fixtures.js";

const NOW = new Date("2026-09-24T10:00:00Z");

function fakeFetch(respond: (body: URLSearchParams) => Response) {
  const requests: URLSearchParams[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    requests.push(body);
    return respond(body);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_at: NOW.getTime() / 1000 + 6 * 3600,
    ...overrides,
  });

function setup(expiresInMs: number, respond = () => tokenResponse()) {
  const tokens = inMemoryTokens({
    accountId: "999",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: new Date(NOW.getTime() + expiresInMs),
    scope: "read,activity:read_all",
  });
  const { fetch, requests } = fakeFetch(respond);
  const alerts: string[] = [];
  const auth = createStravaAuth({
    clientId: "1",
    clientSecret: "fake-secret",
    redirectUri: "http://localhost:3000/auth/strava/callback",
    tokens: tokens.store,
    fetch,
    now: () => NOW,
    onRefreshFailed: async (reason) => {
      alerts.push(reason);
    },
    sleep: async () => {},
  });
  return { auth, tokens, requests, alerts };
}

describe("createStravaAuth().accessToken", () => {
  it("returns the stored token while it is valid", async () => {
    const { auth, requests } = setup(60 * 60 * 1000);
    expect(await auth.accessToken()).toBe("old-access");
    expect(requests).toHaveLength(0);
  });

  it("refreshes near expiry and re-saves both tokens", async () => {
    const { auth, tokens, requests } = setup(60 * 1000);
    expect(await auth.accessToken()).toBe("new-access");
    expect(requests[0]?.get("grant_type")).toBe("refresh_token");
    expect(requests[0]?.get("refresh_token")).toBe("old-refresh");
    expect(tokens.current()).toMatchObject({
      accountId: "999",
      accessToken: "new-access",
      refreshToken: "new-refresh",
      scope: "read,activity:read_all",
    });
  });

  it("shares one refresh between concurrent callers", async () => {
    const { auth, requests } = setup(0);
    await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    expect(requests).toHaveLength(1);
  });

  it("raises StravaAuthError when the refresh token is rejected, and alerts once", async () => {
    const { auth, requests, alerts } = setup(0, () => new Response("{}", { status: 400 }));
    await expect(auth.accessToken()).rejects.toThrow(StravaAuthError);
    await expect(auth.accessToken()).rejects.toThrow(StravaAuthError);
    expect(requests).toHaveLength(2); // no retries for a rejected grant
    expect(alerts).toEqual(["rejected"]);
  });

  // Phase 5 acceptance: an expired token whose refresh keeps failing retries, then alerts.
  it("retries an unavailable token endpoint, then alerts and keeps the stored tokens", async () => {
    const { auth, requests, alerts, tokens } = setup(
      -60_000,
      () => new Response("", { status: 503 }),
    );
    await expect(auth.accessToken()).rejects.toThrow(TokenRefreshError);
    expect(requests).toHaveLength(3);
    expect(alerts).toEqual(["unavailable"]);
    expect(tokens.current()?.refreshToken).toBe("old-refresh");
  });

  it("recovers when a retry succeeds", async () => {
    let calls = 0;
    const { auth, alerts } = setup(-60_000, () =>
      ++calls < 3 ? new Response("", { status: 502 }) : tokenResponse(),
    );
    expect(await auth.accessToken()).toBe("new-access");
    expect(alerts).toEqual([]);
  });

  it("raises StravaAuthError when nothing is connected", async () => {
    const tokens = inMemoryTokens();
    const auth = createStravaAuth({
      clientId: "1",
      clientSecret: "fake-secret",
      redirectUri: "http://localhost/cb",
      tokens: tokens.store,
    });
    await expect(auth.accessToken()).rejects.toThrow(StravaAuthError);
  });
});

describe("createStravaAuth().exchangeCode", () => {
  it("stores the tokens with the athlete id and granted scope", async () => {
    const { auth, tokens, requests } = setup(0, () => tokenResponse({ athlete: { id: 4242 } }));
    expect(await auth.exchangeCode("fake-code", "read,activity:read")).toBe("4242");
    expect(requests[0]?.get("grant_type")).toBe("authorization_code");
    expect(tokens.current()).toMatchObject({ accountId: "4242", scope: "read,activity:read" });
  });
});

describe("authorizeUrl", () => {
  it("carries the state, scopes and callback", () => {
    const url = new URL(setup(0).auth.authorizeUrl("abc"));
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("scope")).toBe("read,activity:read_all,activity:write");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/strava/callback");
  });
});

describe("hasActivityScope", () => {
  it("needs one of the activity scopes", () => {
    expect(hasActivityScope("read,activity:read_all")).toBe(true);
    expect(hasActivityScope("read,activity:read")).toBe(true);
    expect(hasActivityScope("read")).toBe(false);
  });
});

describe("hasWriteScope / canWriteActivities", () => {
  it("needs activity:write, which older connections don't have", async () => {
    expect(hasWriteScope("read,activity:read_all,activity:write")).toBe(true);
    expect(hasWriteScope("read,activity:read_all")).toBe(false);
    const { auth } = setup(60 * 60 * 1000);
    expect(await auth.canWriteActivities()).toBe(false);
  });
});

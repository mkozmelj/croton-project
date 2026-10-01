import { describe, expect, it } from "vitest";
import { createStravaClient, StravaApiError } from "./client.js";
import { StravaAuthError } from "./oauth.js";

function setup(status: number) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(status === 200 ? "{}" : null, { status });
  }) as typeof globalThis.fetch;
  const client = createStravaClient({ auth: { accessToken: async () => "fake-token" }, fetch });
  return { client, requests };
}

describe("createStravaClient().updateActivity", () => {
  it("PUTs the new name and description as JSON", async () => {
    const { client, requests } = setup(200);
    expect(await client.updateActivity(111, { name: "Tempo", description: "Planned" })).toBe(true);
    const [request] = requests;
    expect(request?.url).toBe("https://www.strava.com/api/v3/activities/111");
    expect(request?.init?.method).toBe("PUT");
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      name: "Tempo",
      description: "Planned",
    });
    expect(request?.init?.headers).toMatchObject({
      authorization: "Bearer fake-token",
      "content-type": "application/json",
    });
  });

  it("returns false for a deleted activity and throws on other failures", async () => {
    expect(await setup(404).client.updateActivity(111, { name: "x" })).toBe(false);
    await expect(setup(500).client.updateActivity(111, { name: "x" })).rejects.toThrow(
      StravaApiError,
    );
    await expect(setup(401).client.updateActivity(111, { name: "x" })).rejects.toThrow(
      StravaAuthError,
    );
  });
});

describe("createStravaClient().hasAccess", () => {
  it("asks for the authenticated athlete", async () => {
    const { client, requests } = setup(200);
    expect(await client.hasAccess()).toBe(true);
    expect(requests[0]?.url).toBe("https://www.strava.com/api/v3/athlete");
  });

  it("is false when Strava rejects the token, and throws on other failures", async () => {
    expect(await setup(401).client.hasAccess()).toBe(false);
    await expect(setup(503).client.hasAccess()).rejects.toThrow(StravaApiError);
  });

  it("is false when the token can't be refreshed", async () => {
    const client = createStravaClient({
      auth: {
        accessToken: async () => {
          throw new StravaAuthError("Strava rejected the refresh_token grant");
        },
      },
    });
    expect(await client.hasAccess()).toBe(false);
  });
});

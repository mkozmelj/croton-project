import { describe, expect, it } from "vitest";
import { createIntervalsClient, IntervalsApiError } from "./client.js";

function fakeFetch(response: () => Response) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("createIntervalsClient().wellness", () => {
  it("requests the date range with API-key basic auth", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json([]));
    const client = createIntervalsClient({ apiKey: "fake-key", athleteId: "i123", fetch });

    await client.wellness("2026-09-22", "2026-09-24");

    expect(requests[0]?.url).toBe(
      "https://intervals.icu/api/v1/athlete/i123/wellness?oldest=2026-09-22&newest=2026-09-24",
    );
    const expected = `Basic ${Buffer.from("API_KEY:fake-key").toString("base64")}`;
    expect(requests[0]?.headers.get("authorization")).toBe(expected);
  });

  it("parses records and keeps unknown (custom) fields", async () => {
    const { fetch } = fakeFetch(() =>
      Response.json([{ id: "2026-09-24", hrv: 55.5, restingHR: null, BodyBattery: 80, ctl: 40 }]),
    );
    const [record] = await createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch }).wellness(
      "2026-09-24",
      "2026-09-24",
    );
    expect(record).toMatchObject({ id: "2026-09-24", hrv: 55.5, restingHR: null, BodyBattery: 80 });
  });

  it("raises IntervalsApiError naming the API key on 401", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 401 }));
    const client = createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch });
    await expect(client.wellness("2026-09-24", "2026-09-24")).rejects.toThrow(IntervalsApiError);
    await expect(client.wellness("2026-09-24", "2026-09-24")).rejects.toThrow(/API key/);
  });

  it("rejects a malformed response", async () => {
    const { fetch } = fakeFetch(() => Response.json([{ id: "not-a-date" }]));
    const client = createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch });
    await expect(client.wellness("2026-09-24", "2026-09-24")).rejects.toThrow();
  });
});

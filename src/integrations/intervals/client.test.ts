import { describe, expect, it } from "vitest";
import { createIntervalsClient, IntervalsApiError } from "./client.js";

function fakeFetch(response: () => Response) {
  const requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
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

describe("createIntervalsClient() calendar events", () => {
  const event = {
    category: "WORKOUT" as const,
    type: "Run",
    name: "Tempo",
    start_date_local: "2026-11-17T07:00:00",
    description: "- Tempo 10m 4:50/km Pace",
    moving_time: 600,
    external_id: "croton:plan-1:0",
  };

  it("lists events for the date range", async () => {
    const { fetch, requests } = fakeFetch(() =>
      Response.json([
        { id: 5, category: "WORKOUT", start_date_local: "2026-11-17T07:00:00", external_id: null },
      ]),
    );
    const client = createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch });
    const events = await client.events("2026-11-16", "2026-11-22");
    expect(requests[0]?.url).toBe(
      "https://intervals.icu/api/v1/athlete/i1/events?oldest=2026-11-16&newest=2026-11-22",
    );
    expect(events[0]).toMatchObject({ id: 5, external_id: null });
  });

  it("creates events in one bulk request, without upserting", async () => {
    const { fetch, requests } = fakeFetch(() =>
      Response.json([{ ...event, id: 77, workout_doc: { steps: [] } }]),
    );
    const client = createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch });
    const created = await client.createEvents([event]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://intervals.icu/api/v1/athlete/i1/events/bulk?upsert=false&upsertOnUid=false&updatePlanApplied=false",
      body: [event],
    });
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(created[0]?.id).toBe(77);
  });

  it("sends nothing for an empty list", async () => {
    const { fetch, requests } = fakeFetch(() => Response.json([]));
    await createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch }).createEvents([]);
    expect(requests).toEqual([]);
  });

  it("deletes by id and treats an already-deleted event as done", async () => {
    const { fetch, requests } = fakeFetch(() => new Response("", { status: 404 }));
    const client = createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch });
    await expect(client.deleteEvent(9)).resolves.toBeUndefined();
    expect(requests[0]).toMatchObject({
      method: "DELETE",
      url: "https://intervals.icu/api/v1/athlete/i1/events/9",
    });
  });

  it("raises IntervalsApiError when a delete fails otherwise", async () => {
    const { fetch } = fakeFetch(() => new Response("", { status: 500 }));
    const client = createIntervalsClient({ apiKey: "k", athleteId: "i1", fetch });
    await expect(client.deleteEvent(9)).rejects.toBeInstanceOf(IntervalsApiError);
  });
});

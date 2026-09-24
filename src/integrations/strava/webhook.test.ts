import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";
import { registerStravaWebhook, STRAVA_WEBHOOK_PATH, type StravaEvent } from "./webhook.js";

const VERIFY_TOKEN = "fake-verify-token";
const SUBSCRIPTION_ID = 5;
const ATHLETE_ID = 4242;

// `null` means "not configured"; undefined would fall back to the default.
function setup({
  subscriptionId = SUBSCRIPTION_ID as number | null,
  athleteId = String(ATHLETE_ID) as string | null,
} = {}) {
  const events: StravaEvent[] = [];
  const app = buildServer({ logger: pino({ level: "silent" }) });
  registerStravaWebhook(app, {
    verifyToken: VERIFY_TOKEN,
    subscriptionId: subscriptionId ?? undefined,
    athleteId: async () => athleteId,
    onEvent: (event) => events.push(event),
  });
  return { app, events };
}

const event = (overrides: Partial<StravaEvent> = {}): StravaEvent => ({
  object_type: "activity",
  object_id: 111,
  aspect_type: "create",
  owner_id: ATHLETE_ID,
  subscription_id: SUBSCRIPTION_ID,
  event_time: 1_790_000_000,
  updates: {},
  ...overrides,
});

const handshake = (token: string) =>
  `${STRAVA_WEBHOOK_PATH}?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=${token}`;

describe(`GET ${STRAVA_WEBHOOK_PATH} (subscription handshake)`, () => {
  it("echoes the challenge for the right verify token", async () => {
    const response = await setup().app.inject({ url: handshake(VERIFY_TOKEN) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ "hub.challenge": "abc123" });
  });

  it("rejects a wrong verify token with an empty 401", async () => {
    const response = await setup().app.inject({ url: handshake("wrong") });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("");
  });
});

describe(`POST ${STRAVA_WEBHOOK_PATH}`, () => {
  const post = (app: ReturnType<typeof setup>["app"], payload: unknown) =>
    app.inject({ method: "POST", url: STRAVA_WEBHOOK_PATH, payload: payload as object });

  it("accepts an event for our subscription and athlete", async () => {
    const { app, events } = setup();
    const response = await post(app, event());
    expect(response.statusCode).toBe(200);
    expect(events).toEqual([event()]);
  });

  it.each([
    ["another subscription", event({ subscription_id: 6 })],
    ["another athlete", event({ owner_id: 1 })],
    ["a malformed payload", { object_type: "activity" }],
  ])("rejects %s with an empty 401", async (_label, payload) => {
    const { app, events } = setup();
    const response = await post(app, payload);
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("");
    expect(events).toEqual([]);
  });

  it("rejects everything until the subscription id is configured", async () => {
    const { app, events } = setup({ subscriptionId: null });
    expect((await post(app, event())).statusCode).toBe(401);
    expect(events).toEqual([]);
  });

  it("rejects everything while Strava isn't connected", async () => {
    const { app, events } = setup({ athleteId: null });
    expect((await post(app, event())).statusCode).toBe(401);
    expect(events).toEqual([]);
  });
});

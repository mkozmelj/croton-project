import { createHmac } from "node:crypto";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { HealthMetricsUpdate } from "../../db/health-metrics.js";
import { buildServer } from "../../server.js";
import { registerTerraWebhook, TERRA_WEBHOOK_PATH, verifyTerraSignature } from "./webhook.js";

const SECRET = "fake-terra-signing-secret";

const sign = (body: string, secret = SECRET, t = "1790000000") =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

const bodyPayload = JSON.stringify({
  type: "body",
  data: [
    {
      metadata: { start_time: "2026-09-24T07:00:00+02:00" },
      measurements_data: { day_avg_weight_kg: 70 },
    },
  ],
});

function setup({ failUpsert = false } = {}) {
  const upserts: HealthMetricsUpdate[] = [];
  const unparseable: unknown[] = [];
  const serverErrors: string[] = [];
  const authEvents: string[] = [];
  const app = buildServer({
    logger: pino({ level: "silent" }),
    onServerError: async (route) => {
      serverErrors.push(route);
    },
  });
  registerTerraWebhook(app, {
    signingSecret: SECRET,
    timeZone: "Europe/Ljubljana",
    health: {
      upsert: async (update) => {
        if (failUpsert) throw new Error("db down");
        upserts.push(update);
      },
    },
    onAuthEvent: async (event) => {
      authEvents.push(event.type);
    },
    onUnparseable: async (error) => {
      unparseable.push(error);
    },
  });
  const post = (payload: string, headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: TERRA_WEBHOOK_PATH,
      headers: { "content-type": "application/json", ...headers },
      payload,
    });
  return { app, post, upserts, unparseable, serverErrors, authEvents };
}

describe("verifyTerraSignature", () => {
  it("accepts a correct signature, including among several v1 entries", () => {
    const raw = Buffer.from(bodyPayload);
    expect(verifyTerraSignature(sign(bodyPayload), raw, SECRET)).toBe(true);
    const [t, v1] = sign(bodyPayload).split(",");
    expect(verifyTerraSignature(`${t},v1=deadbeef,${v1}`, raw, SECRET)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["a wrong secret", sign(bodyPayload, "other-secret")],
    ["a different timestamp", sign(bodyPayload).replace("t=1790000000", "t=1790000001")],
    ["no timestamp", sign(bodyPayload).split(",")[1]],
    ["only a v0 scheme", sign(bodyPayload).replace("v1=", "v0=")],
  ])("rejects %s", (_label, header) => {
    expect(verifyTerraSignature(header, Buffer.from(bodyPayload), SECRET)).toBe(false);
  });
});

describe(`POST ${TERRA_WEBHOOK_PATH}`, () => {
  it("stores metrics from a signed payload", async () => {
    const { post, upserts } = setup();
    const response = await post(bodyPayload, { "terra-signature": sign(bodyPayload) });
    expect(response.statusCode).toBe(200);
    expect(upserts).toMatchObject([{ date: "2026-09-24", values: { weightKg: 70 } }]);
  });

  it("verifies against the exact raw bytes, not re-serialized JSON", async () => {
    const { post, upserts } = setup();
    const spaced = bodyPayload.replace(/,/g, ", ");
    const response = await post(spaced, { "terra-signature": sign(spaced) });
    expect(response.statusCode).toBe(200);
    expect(upserts).toHaveLength(1);
  });

  it.each([
    ["a bad signature", { "terra-signature": sign(bodyPayload, "other-secret") }],
    ["no signature", {}],
  ])("rejects %s with an empty 401 and writes nothing", async (_label, headers) => {
    const { post, upserts } = setup();
    const response = await post(bodyPayload, headers);
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("");
    expect(upserts).toEqual([]);
  });

  it("rejects before parsing: unsigned invalid JSON is a 401, not a 400", async () => {
    const { post } = setup();
    expect((await post("{not json", {})).statusCode).toBe(401);
  });

  it("acknowledges and alerts on a signed payload it can't read", async () => {
    const { post, unparseable, serverErrors } = setup();
    const response = await post("{not json", { "terra-signature": sign("{not json") });
    expect(response.statusCode).toBe(200);
    expect(unparseable).toHaveLength(1);
    expect(serverErrors).toEqual([]);
  });

  it("answers 500 and alerts when storing fails, so Terra retries", async () => {
    const { post, serverErrors, unparseable } = setup({ failUpsert: true });
    const response = await post(bodyPayload, { "terra-signature": sign(bodyPayload) });
    expect(response.statusCode).toBe(500);
    expect(serverErrors).toEqual([TERRA_WEBHOOK_PATH]);
    expect(unparseable).toEqual([]);
  });

  it("passes auth events on", async () => {
    const { post, authEvents } = setup();
    const payload = JSON.stringify({
      type: "auth",
      status: "success",
      user: { provider: "GARMIN" },
    });
    expect((await post(payload, { "terra-signature": sign(payload) })).statusCode).toBe(200);
    expect(authEvents).toEqual(["auth"]);
  });

  it("leaves JSON body parsing intact on other routes", async () => {
    const { app } = setup();
    app.post("/echo", async (request) => request.body);
    const response = await app.inject({ method: "POST", url: "/echo", payload: { a: 1 } });
    expect(response.json()).toEqual({ a: 1 });
  });
});

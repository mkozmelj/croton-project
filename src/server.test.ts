import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("GET /health", () => {
  it("responds with ok", async () => {
    const app = buildServer({ logger: pino({ level: "silent" }) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("server error handling", () => {
  it("logs and reports a 5xx without leaking the error to the caller", async () => {
    const reported: string[] = [];
    const app = buildServer({
      logger: pino({ level: "silent" }),
      onServerError: async (route) => {
        reported.push(route);
      },
    });
    app.post("/webhook/test", async () => {
      throw new Error("db down with secret details");
    });

    const response = await app.inject({ method: "POST", url: "/webhook/test?x=1", payload: {} });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe("");
    expect(reported).toEqual(["/webhook/test"]);
  });

  it("passes client errors through without an alert", async () => {
    const reported: string[] = [];
    const app = buildServer({
      logger: pino({ level: "silent" }),
      onServerError: async (route) => {
        reported.push(route);
      },
    });
    app.post("/webhook/test", async () => ({ ok: true }));

    const response = await app.inject({
      method: "POST",
      url: "/webhook/test",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(reported).toEqual([]);
  });
});

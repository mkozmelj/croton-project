import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("GET /health", () => {
  it("responds with ok", async () => {
    const app = buildServer({ logLevel: "silent" });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

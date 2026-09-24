import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { HOME_PATH, PRIVACY_PATH, registerInfoPages } from "./pages.js";
import { buildServer } from "./server.js";

describe("info pages", () => {
  it("serves the homepage and privacy policy as HTML", async () => {
    const app = buildServer({ logger: pino({ level: "silent" }) });
    registerInfoPages(app);
    const home = await app.inject(HOME_PATH);
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.body).toContain(`href="${PRIVACY_PATH}"`);
    const privacy = await app.inject(PRIVACY_PATH);
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain("calendar.events");
  });
});

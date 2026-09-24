import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const base = {
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_AUTHORIZED_CHAT_ID: "1000",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
};

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      TIMEZONE: "Europe/Ljubljana",
      MONTHLY_LLM_BUDGET_EUR: 14,
      TELEGRAM_AUTHORIZED_CHAT_ID: 1000,
      DISABLE_THINKING: false,
    });
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("parses DISABLE_THINKING=%s as %s", (value, expected) => {
    expect(parseEnv({ ...base, DISABLE_THINKING: value }).DISABLE_THINKING).toBe(expected);
  });

  it("rejects a DISABLE_THINKING value that isn't true/false", () => {
    expect(() => parseEnv({ ...base, DISABLE_THINKING: "yes" })).toThrow();
  });

  it("treats empty values as unset", () => {
    expect(parseEnv({ ...base, STRAVA_CLIENT_ID: "" }).STRAVA_CLIENT_ID).toBeUndefined();
  });

  it("requires the core secrets", () => {
    expect(() => parseEnv({ ...base, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("requires APP_URL and the webhook secret in production", () => {
    expect(() => parseEnv({ ...base, NODE_ENV: "production" })).toThrow(
      /APP_URL[\s\S]*TELEGRAM_WEBHOOK_SECRET/,
    );
    const env = parseEnv({
      ...base,
      NODE_ENV: "production",
      APP_URL: "https://example.up.railway.app",
      TELEGRAM_WEBHOOK_SECRET: "a".repeat(32),
    });
    expect(env.NODE_ENV).toBe("production");
  });

  it("rejects a webhook secret with characters Telegram won't accept", () => {
    expect(() => parseEnv({ ...base, TELEGRAM_WEBHOOK_SECRET: `${"a".repeat(20)}!` })).toThrow();
  });
});

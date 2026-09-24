import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { connectionStringSecrets, REDACT_PATHS, scrubSecrets, serializeError } from "./logger.js";

function captureLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: "[Redacted]" } }, stream);
  return { logger, output: () => lines.join("") };
}

describe("logger redaction", () => {
  it("redacts secret headers and token fields", () => {
    const { logger, output } = captureLogger();
    logger.info({
      req: {
        headers: { "x-telegram-bot-api-secret-token": "hook-secret", authorization: "Bearer abc" },
      },
      tokens: { access_token: "at-123", refresh_token: "rt-456" },
    });
    const text = output();
    for (const secret of ["hook-secret", "Bearer abc", "at-123", "rt-456"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[Redacted]");
  });
});

describe("scrubSecrets", () => {
  it("removes known secret values from free text", () => {
    const text = "GET https://api.telegram.org/bot123456:ABCDEFGH/sendMessage failed";
    expect(scrubSecrets(text, ["123456:ABCDEFGH"])).toBe(
      "GET https://api.telegram.org/bot[Redacted]/sendMessage failed",
    );
  });

  it("ignores values too short to be real secrets", () => {
    expect(scrubSecrets("port 3000", ["3000"])).toBe("port 3000");
  });
});

describe("serializeError", () => {
  const SECRET = "123456:ABCDEFGHIJ";

  it("scrubs secrets from the cause chain and extra properties", () => {
    const error = Object.assign(
      new Error("request failed", { cause: new Error(`GET /bot${SECRET}/getMe`) }),
      { request: { url: `https://api.telegram.org/bot${SECRET}/getMe` } },
    );
    const serialized = JSON.stringify(serializeError(error, [SECRET]));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("request failed");
  });

  it("falls back to the scrubbed message when extra properties are circular", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const error = Object.assign(new Error(`token ${SECRET}`), { circular });
    expect(serializeError(error, [SECRET])).toMatchObject({ message: "token [Redacted]" });
  });
});

describe("connectionStringSecrets", () => {
  it("includes the password on its own, raw and decoded", () => {
    expect(connectionStringSecrets("postgresql://user:p%40ssword123@db.example.com/app")).toEqual([
      "postgresql://user:p%40ssword123@db.example.com/app",
      "p%40ssword123",
      "p@ssword123",
    ]);
  });
});

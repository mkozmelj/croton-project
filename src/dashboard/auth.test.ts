import { describe, expect, it } from "vitest";
import {
  checkTelegramLogin,
  clearedSessionCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  signSession,
  verifySession,
} from "./auth.js";
import { signedLogin, TEST_BOT_TOKEN, TEST_SESSION_SECRET, TEST_USER_ID } from "./test-helpers.js";

const BOT_TOKEN = TEST_BOT_TOKEN;
const USER_ID = TEST_USER_ID;
const SECRET = TEST_SESSION_SECRET;
const NOW = new Date("2026-11-17T10:00:00Z");
const nowSeconds = NOW.getTime() / 1000;

const login = (overrides: Record<string, string> = {}) =>
  signedLogin({
    id: String(USER_ID),
    first_name: "Test",
    username: "test_user",
    auth_date: String(nowSeconds - 30),
    ...overrides,
  });

const check = (query: unknown) =>
  checkTelegramLogin(query, { botToken: BOT_TOKEN, authorizedUserId: USER_ID, now: NOW });

describe("checkTelegramLogin", () => {
  it("accepts a fresh login of the authorized user", () => {
    expect(check(login())).toEqual({ ok: true, userId: USER_ID });
  });

  it("rejects a changed field", () => {
    expect(check({ ...login(), first_name: "Other" })).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("rejects a login signed with another bot's token", () => {
    const forged = signedLogin(
      { id: String(USER_ID), auth_date: String(nowSeconds) },
      "999:another-bot",
    );
    expect(check(forged)).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("rejects a login older than 5 minutes or from the future", () => {
    expect(check(login({ auth_date: String(nowSeconds - 301) }))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(check(login({ auth_date: String(nowSeconds + 3600) }))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects any other Telegram user", () => {
    expect(check(login({ id: "777" }))).toEqual({ ok: false, reason: "not_authorized" });
  });

  it("rejects malformed queries", () => {
    expect(check({})).toEqual({ ok: false, reason: "malformed" });
    expect(check({ ...login(), hash: "zz" })).toEqual({ ok: false, reason: "malformed" });
    expect(check({ ...login(), id: ["1", "2"] })).toEqual({ ok: false, reason: "malformed" });
    expect(check("id=1")).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("session cookie", () => {
  const verify = (value: string | undefined, now = NOW, authorizedUserId = USER_ID) =>
    verifySession(value, { secret: SECRET, authorizedUserId, now });

  it("verifies its own session for 30 days", () => {
    const value = signSession(USER_ID, NOW, SECRET);
    expect(verify(value)).toBe(true);
    expect(verify(value, new Date(NOW.getTime() + 29 * 86_400_000))).toBe(true);
    expect(verify(value, new Date(NOW.getTime() + 31 * 86_400_000))).toBe(false);
  });

  it("rejects a forged, tampered or foreign session", () => {
    const value = signSession(USER_ID, NOW, SECRET);
    const [, signature] = value.split(".");
    const otherPayload = Buffer.from(JSON.stringify({ uid: USER_ID, exp: 9e9 })).toString(
      "base64url",
    );
    expect(verify(`${otherPayload}.${signature}`)).toBe(false);
    expect(verify(signSession(USER_ID, NOW, "another-secret-of-at-least-32-bytes!!"))).toBe(false);
    expect(verify(signSession(777, NOW, SECRET))).toBe(false);
    expect(verify(undefined)).toBe(false);
    expect(verify("garbage")).toBe(false);
    expect(verify(`${value}.extra`)).toBe(false);
  });

  it("reads the cookie from a header and builds the Set-Cookie values", () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`, SESSION_COOKIE)).toBe("abc.def");
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined();
    const set = sessionCookie("abc.def", { secure: true });
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/dashboard");
    expect(set).toContain(`Max-Age=${30 * 86_400}`);
    expect(clearedSessionCookie({ secure: true })).toContain("Max-Age=0");
  });
});

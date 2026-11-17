import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// ADR-022: the dashboard signs in with the Telegram Login Widget, then keeps a signed session
// cookie. Only the authorized chat's user gets in (in a private chat the chat ID is the user ID,
// ADR-006).

export const SESSION_COOKIE = "croton_session";
export const SESSION_DAYS = 30;
// A widget login older than this is refused, so a leaked login URL can't be replayed later.
export const LOGIN_MAX_AGE_SECONDS = 5 * 60;
// Clock skew allowed for an auth_date slightly in the future.
const FUTURE_SKEW_SECONDS = 60;

export type LoginCheck =
  | { ok: true; userId: number }
  | { ok: false; reason: "malformed" | "bad_hash" | "expired" | "not_authorized" };

// The widget's redirect query: every field is a string, `hash` is hex.
const loginQuerySchema = z
  .record(z.string(), z.string())
  .refine((query) => typeof query.hash === "string" && typeof query.id === "string");

// Telegram's documented check: HMAC-SHA256 over the sorted `key=value` lines of every field
// but `hash`, keyed with SHA-256 of the bot token, compared in constant time (ADR-012).
export function checkTelegramLogin(
  query: unknown,
  { botToken, authorizedUserId, now }: { botToken: string; authorizedUserId: number; now: Date },
): LoginCheck {
  const parsed = loginQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const { hash, ...fields } = parsed.data;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed" };

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex")))
    return { ok: false, reason: "bad_hash" };

  const authDate = Number(fields.auth_date);
  const age = now.getTime() / 1000 - authDate;
  if (!Number.isInteger(authDate) || age > LOGIN_MAX_AGE_SECONDS || age < -FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  const userId = Number(fields.id);
  if (userId !== authorizedUserId) return { ok: false, reason: "not_authorized" };
  return { ok: true, userId };
}

// The cookie value: base64url JSON `{ uid, exp }` (exp in seconds), a dot, and its
// HMAC-SHA256 under DASHBOARD_SESSION_SECRET. Rotating the secret logs every session out.
export function signSession(userId: number, now: Date, secret: string): string {
  const exp = Math.floor(now.getTime() / 1000) + SESSION_DAYS * 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

const sessionSchema = z.object({ uid: z.number().int(), exp: z.number().int() });

// True when the cookie is ours, unexpired and for the authorized user.
export function verifySession(
  value: string | undefined,
  { secret, authorizedUserId, now }: { secret: string; authorizedUserId: number; now: Date },
): boolean {
  if (!value) return false;
  const [payload, signature, ...rest] = value.split(".");
  if (!payload || !signature || rest.length > 0) return false;
  const expected = Buffer.from(sign(payload, secret), "base64url");
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const session = sessionSchema.safeParse(decoded);
  return (
    session.success &&
    session.data.uid === authorizedUserId &&
    session.data.exp > now.getTime() / 1000
  );
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// One cookie's value from a `Cookie` header.
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

export function sessionCookie(value: string, { secure }: { secure: boolean }): string {
  return cookie(value, SESSION_DAYS * 24 * 60 * 60, secure);
}

export function clearedSessionCookie({ secure }: { secure: boolean }): string {
  return cookie("", 0, secure);
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/dashboard",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

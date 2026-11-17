import { createHash, createHmac } from "node:crypto";

// Fake values only.
export const TEST_BOT_TOKEN = "123456:TEST-token-not-real";
export const TEST_USER_ID = 4242;
export const TEST_SESSION_SECRET = "a-test-session-secret-of-at-least-32-bytes";

// Signs login fields the way Telegram's widget does.
export function signedLogin(fields: Record<string, string>, botToken = TEST_BOT_TOKEN) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return { ...fields, hash };
}

import { z } from "zod";
import type { OAuthTokenStore } from "../../db/oauth-tokens.js";
import { timeoutSignal } from "../../utils/http.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Create, change and delete events (and read them). No access to calendar settings or sharing.
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// The athlete has to (re)connect Google: nothing stored, access revoked, or refresh rejected
// (e.g. the 7-day expiry while the consent screen is in "Testing", ADR-011).
export class GoogleAuthError extends Error {
  override readonly name = "GoogleAuthError";
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  // Only on the first grant (with access_type=offline + prompt=consent) and occasionally on refresh.
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

export type GoogleAuthDeps = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokens: OAuthTokenStore;
  fetch?: typeof fetch;
  now?: () => Date;
};

export type GoogleAuth = {
  authorizeUrl(state: string): string;
  // Exchanges the callback's code and stores the tokens.
  exchangeCode(code: string): Promise<void>;
  // A valid access token, refreshed and re-saved when close to expiry.
  accessToken(): Promise<string>;
  isConnected(): Promise<boolean>;
};

export function createGoogleAuth(deps: GoogleAuthDeps): GoogleAuth {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  let refreshing: Promise<string> | null = null;

  async function requestTokens(params: Record<string, string>) {
    const response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        ...params,
      }),
      signal: timeoutSignal(),
    });
    if (response.status === 400 || response.status === 401) {
      // invalid_grant: revoked, expired (Testing mode) or already-used code.
      throw new GoogleAuthError(`Google rejected the ${params.grant_type} grant`);
    }
    if (!response.ok) throw new Error(`Google token endpoint returned ${response.status}`);
    return tokenResponseSchema.parse(await response.json());
  }

  const expiry = (expiresIn: number) => new Date(now().getTime() + expiresIn * 1000);

  async function refresh(): Promise<string> {
    const stored = await deps.tokens.get("google");
    if (!stored) throw new GoogleAuthError("Google Calendar is not connected");
    const fresh = await requestTokens({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    // ADR-011: always re-save both; Google keeps the refresh token unless it sends a new one.
    await deps.tokens.save("google", {
      ...stored,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token ?? stored.refreshToken,
      expiresAt: expiry(fresh.expires_in),
    });
    return fresh.access_token;
  }

  return {
    authorizeUrl(state) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: deps.clientId,
        redirect_uri: deps.redirectUri,
        response_type: "code",
        scope: GOOGLE_CALENDAR_SCOPE,
        // Offline access + forced consent, so every grant returns a refresh token.
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      return url.toString();
    },

    async exchangeCode(code) {
      const tokens = await requestTokens({
        grant_type: "authorization_code",
        code,
        redirect_uri: deps.redirectUri,
      });
      if (!tokens.refresh_token) throw new Error("Google token response has no refresh token");
      if (!hasCalendarScope(tokens.scope ?? "")) {
        throw new GoogleAuthError("Calendar access was not granted");
      }
      await deps.tokens.save("google", {
        accountId: null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: expiry(tokens.expires_in),
        scope: tokens.scope ?? null,
      });
    },

    async accessToken() {
      const stored = await deps.tokens.get("google");
      if (!stored) throw new GoogleAuthError("Google Calendar is not connected");
      if (stored.expiresAt.getTime() - now().getTime() > REFRESH_MARGIN_MS) {
        return stored.accessToken;
      }
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    async isConnected() {
      return (await deps.tokens.get("google")) !== null;
    },
  };
}

// Google returns granted scopes space-separated; the athlete can untick calendar access.
export function hasCalendarScope(grantedScope: string): boolean {
  return grantedScope.split(" ").includes(GOOGLE_CALENDAR_SCOPE);
}

import { z } from "zod";
import type { OAuthTokenStore } from "../../db/oauth-tokens.js";
import { timeoutSignal } from "../../utils/http.js";
import { createTokenRefresher, type RefreshAlert } from "../token-refresh.js";

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";

// `activity:read_all` includes private activities; `read` is required by Strava for every app.
// `activity:write` lets a matched activity take the planned session's title and description;
// it's optional (the athlete can untick it), so everything else works without it.
export const STRAVA_SCOPES = "read,activity:read_all,activity:write";

// Refresh a little before the 6-hour expiry so a token never dies mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// The athlete has to (re)connect Strava: no token stored, access revoked, or refresh rejected.
export class StravaAuthError extends Error {
  override readonly name = "StravaAuthError";
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int(), // epoch seconds
  athlete: z.object({ id: z.number().int() }).optional(),
});

type Fetch = typeof fetch;

export type StravaAuthDeps = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokens: OAuthTokenStore;
  fetch?: Fetch;
  now?: () => Date;
  // Called once per failure streak when a refresh finally fails (token-refresh.ts).
  onRefreshFailed?: RefreshAlert;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export type StravaAuth = {
  authorizeUrl(state: string): string;
  // Exchanges the callback's code and stores the tokens. Returns the Strava athlete id.
  exchangeCode(code: string, grantedScope: string): Promise<string>;
  // A valid access token, refreshed (and both tokens re-saved) when close to expiry.
  accessToken(): Promise<string>;
  // The connected athlete's Strava id, for the webhook owner check (ADR-012).
  athleteId(): Promise<string | null>;
  // Whether the athlete granted `activity:write` (renaming a matched activity needs it).
  canWriteActivities(): Promise<boolean>;
};

export function createStravaAuth(deps: StravaAuthDeps): StravaAuth {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  let refreshing: Promise<string> | null = null;
  const refreshTokens = createTokenRefresher({
    provider: "strava",
    isRejected: (error) => error instanceof StravaAuthError,
    onAlert: deps.onRefreshFailed,
    delaysMs: deps.retryDelaysMs,
    sleep: deps.sleep,
  });

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
      // Revoked or already-used grant: only a new authorization fixes it.
      throw new StravaAuthError(`Strava rejected the ${params.grant_type} grant`);
    }
    if (!response.ok) {
      throw new Error(`Strava token endpoint returned ${response.status}`);
    }
    return tokenResponseSchema.parse(await response.json());
  }

  async function refresh(): Promise<string> {
    const stored = await deps.tokens.get("strava");
    if (!stored) throw new StravaAuthError("Strava is not connected");
    // Transient failures are retried; a final failure alerts the athlete (token-refresh.ts).
    const fresh = await refreshTokens(() =>
      requestTokens({ grant_type: "refresh_token", refresh_token: stored.refreshToken }),
    );
    // ADR-011: Strava may rotate the refresh token, so both are always re-saved.
    await deps.tokens.save("strava", {
      ...stored,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresAt: new Date(fresh.expires_at * 1000),
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
        approval_prompt: "auto",
        scope: STRAVA_SCOPES,
        state,
      }).toString();
      return url.toString();
    },

    async exchangeCode(code, grantedScope) {
      const tokens = await requestTokens({ grant_type: "authorization_code", code });
      if (!tokens.athlete) throw new Error("Strava token response has no athlete");
      const athleteId = String(tokens.athlete.id);
      await deps.tokens.save("strava", {
        accountId: athleteId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(tokens.expires_at * 1000),
        scope: grantedScope,
      });
      return athleteId;
    },

    async accessToken() {
      const stored = await deps.tokens.get("strava");
      if (!stored) throw new StravaAuthError("Strava is not connected");
      if (stored.expiresAt.getTime() - now().getTime() > REFRESH_MARGIN_MS) {
        return stored.accessToken;
      }
      // Concurrent callers share one refresh; a second refresh would use a rotated-out token.
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },

    async athleteId() {
      return (await deps.tokens.get("strava"))?.accountId ?? null;
    },

    async canWriteActivities() {
      return hasWriteScope((await deps.tokens.get("strava"))?.scope ?? "");
    },
  };
}

// Strava reports the scopes the athlete actually granted, which can be fewer than requested.
export function hasActivityScope(grantedScope: string): boolean {
  const scopes = grantedScope.split(",");
  return scopes.includes("activity:read") || scopes.includes("activity:read_all");
}

// Connections made before `activity:write` was requested don't have it until a /reauth.
export function hasWriteScope(grantedScope: string): boolean {
  return grantedScope.split(",").includes("activity:write");
}

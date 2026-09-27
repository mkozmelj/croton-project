import type { OAuthProvider } from "../db/oauth-tokens.js";

// Shared by the Strava and Google OAuth clients (ADR-011). A refresh that fails for a
// transient reason (network error, timeout, 5xx, 429) is retried with backoff. A rejected
// grant (revoked access, expired refresh token) is permanent and isn't retried. Either way,
// a refresh that finally fails alerts the athlete once per failure streak.

// Waits before the 2nd and 3rd attempt: 3 attempts in total.
export const REFRESH_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

export type RefreshFailureReason = "rejected" | "unavailable";

// Every attempt failed for a transient reason. The last error is the `cause`.
export class TokenRefreshError extends Error {
  override readonly name = "TokenRefreshError";

  constructor(
    readonly provider: OAuthProvider,
    readonly attempts: number,
    options: { cause: unknown },
  ) {
    super(`${provider} token refresh failed after ${attempts} attempts`, options);
  }
}

export type RetryOptions = {
  delaysMs?: readonly number[];
  // Errors that retrying can't fix; thrown straight away.
  isPermanent: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Runs `task` until it succeeds, a permanent error comes back, or the delays run out, then
// throws the last error.
export async function withRetry<T>(
  task: () => Promise<T>,
  { delaysMs = REFRESH_RETRY_DELAYS_MS, isPermanent, sleep = defaultSleep }: RetryOptions,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (isPermanent(error) || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

// The errors a refresh already alerted about, so a boundary further up (e.g. the background
// task runner) doesn't send a second message for the same failure.
const reported = new WeakSet<object>();

export function isReportedRefreshFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && reported.has(error);
}

export type RefreshAlert = (reason: RefreshFailureReason, error: unknown) => Promise<void>;

export type TokenRefresherOptions = {
  provider: OAuthProvider;
  // The provider's "reconnect needed" error (StravaAuthError, GoogleAuthError).
  isRejected: (error: unknown) => boolean;
  // Called on the first failed refresh of a streak. A failing alert is ignored.
  onAlert?: RefreshAlert | undefined;
  delaysMs?: readonly number[] | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

// Wraps one refresh request: retries transient failures, alerts once per failure streak, and
// throws either the rejection or a TokenRefreshError. A successful refresh ends the streak.
export function createTokenRefresher(options: TokenRefresherOptions) {
  const delaysMs = options.delaysMs ?? REFRESH_RETRY_DELAYS_MS;
  let failing = false;

  return async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      const result = await withRetry(request, {
        delaysMs,
        isPermanent: options.isRejected,
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
      failing = false;
      return result;
    } catch (error) {
      const rejected = options.isRejected(error);
      const failure = rejected
        ? error
        : new TokenRefreshError(options.provider, delaysMs.length + 1, { cause: error });
      if (typeof failure === "object" && failure !== null) reported.add(failure);
      if (!failing) {
        failing = true;
        await options.onAlert?.(rejected ? "rejected" : "unavailable", failure).catch(() => {
          // Best effort; the refresh error is what the caller sees.
        });
      }
      throw failure;
    }
  };
}

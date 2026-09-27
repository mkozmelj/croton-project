import { describe, expect, it } from "vitest";
import {
  createTokenRefresher,
  isReportedRefreshFailure,
  type RefreshFailureReason,
  TokenRefreshError,
} from "./token-refresh.js";

class RejectedError extends Error {}

function setup() {
  const alerts: RefreshFailureReason[] = [];
  const waits: number[] = [];
  const refresh = createTokenRefresher({
    provider: "strava",
    isRejected: (error) => error instanceof RejectedError,
    onAlert: async (reason) => {
      alerts.push(reason);
    },
    delaysMs: [10, 40],
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { refresh, alerts, waits };
}

// A request that fails `failures` times with `error`, then returns "token".
function flaky(failures: number, error: () => Error = () => new Error("503")) {
  let calls = 0;
  const request = async () => {
    calls++;
    if (calls <= failures) throw error();
    return "token";
  };
  return { request, calls: () => calls };
}

describe("createTokenRefresher", () => {
  it("retries transient failures with backoff and succeeds without an alert", async () => {
    const { refresh, alerts, waits } = setup();
    const { request, calls } = flaky(2);
    await expect(refresh(request)).resolves.toBe("token");
    expect(calls()).toBe(3);
    expect(waits).toEqual([10, 40]);
    expect(alerts).toEqual([]);
  });

  it("alerts after 3 failed attempts and throws a reported TokenRefreshError", async () => {
    const { refresh, alerts } = setup();
    const { request, calls } = flaky(5);
    const error = await refresh(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenRefreshError);
    expect(error).toMatchObject({ provider: "strava", attempts: 3 });
    expect(isReportedRefreshFailure(error)).toBe(true);
    expect(calls()).toBe(3);
    expect(alerts).toEqual(["unavailable"]);
  });

  it("doesn't retry a rejected grant and alerts straight away", async () => {
    const { refresh, alerts, waits } = setup();
    const { request, calls } = flaky(1, () => new RejectedError("invalid_grant"));
    await expect(refresh(request)).rejects.toBeInstanceOf(RejectedError);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
    expect(alerts).toEqual(["rejected"]);
  });

  it("alerts once per failure streak, and again after a success", async () => {
    const { refresh, alerts } = setup();
    const rejected = async () => {
      throw new RejectedError("invalid_grant");
    };
    await refresh(rejected).catch(() => {});
    await refresh(rejected).catch(() => {});
    await refresh(async () => "ok");
    await refresh(rejected).catch(() => {});
    expect(alerts).toEqual(["rejected", "rejected"]);
  });

  it("still throws the refresh error when the alert itself fails", async () => {
    const refresh = createTokenRefresher({
      provider: "google",
      isRejected: () => true,
      onAlert: async () => {
        throw new Error("telegram down");
      },
    });
    await expect(
      refresh(async () => {
        throw new RejectedError("x");
      }),
    ).rejects.toBeInstanceOf(RejectedError);
  });
});

import { describe, expect, it } from "vitest";
import { createCheckIn } from "./check-in.js";

describe("createCheckIn", () => {
  it("expires sessions older than 3 days first, then asks about the rest of the past days", async () => {
    const calls: string[] = [];
    const checkIn = createCheckIn({
      plans: {
        async expireUnanswered(before) {
          calls.push(`expire <${before}`);
          return 2;
        },
        async markUnconfirmed(from, before) {
          calls.push(`mark ${from}..<${before}`);
          return [];
        },
      },
      timeZone: "Europe/Ljubljana",
      // 08:00 local on Wednesday 25 November.
      now: () => new Date("2026-11-25T07:00:00Z"),
    });
    expect(await checkIn.run()).toEqual({ toAsk: [], expired: 2 });
    expect(calls).toEqual(["expire <2026-11-22", "mark 2026-11-22..<2026-11-25"]);
  });
});

import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { HealthMetricsUpdate } from "../../db/health-metrics.js";
import { createWellnessSync } from "./wellness-sync.js";

describe("createWellnessSync().syncRecent", () => {
  it("reads the last three local days and upserts the ones with values", async () => {
    const ranges: [string, string][] = [];
    const upserts: HealthMetricsUpdate[] = [];
    const sync = createWellnessSync({
      client: {
        wellness: async (oldest, newest) => {
          ranges.push([oldest, newest]);
          return [
            { id: "2026-09-22", hrv: 50 },
            { id: "2026-09-23", ctl: 40 }, // nothing health_metrics stores
            { id: "2026-09-24", sleepSecs: 25_200 },
          ];
        },
      },
      health: {
        upsert: async (update) => {
          upserts.push(update);
        },
      },
      timeZone: "Europe/Ljubljana",
      logger: pino({ level: "silent" }),
      // 00:30 on the 24th in Ljubljana, still the 23rd in UTC.
      now: () => new Date("2026-09-23T22:30:00Z"),
    });

    expect(await sync.syncRecent()).toEqual(["2026-09-22", "2026-09-24"]);
    expect(ranges).toEqual([["2026-09-22", "2026-09-24"]]);
    expect(upserts.map((update) => update.date)).toEqual(["2026-09-22", "2026-09-24"]);
  });
});

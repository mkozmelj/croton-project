import type { Logger } from "pino";
import type { HealthMetricsStore } from "../../db/health-metrics.js";
import { addDays, localDate } from "../../utils/dates.js";
import type { IntervalsClient } from "./client.js";
import { hasHealthValues, healthUpdateFromWellness } from "./mapper.js";

// Garmin data can land in Intervals.icu late (the watch syncs whenever the phone is near),
// and last night's sleep may be revised in the morning — re-read a few days every run.
export const WELLNESS_LOOKBACK_DAYS = 3;

type WellnessSyncDeps = {
  client: Pick<IntervalsClient, "wellness">;
  health: Pick<HealthMetricsStore, "upsert">;
  timeZone: string;
  logger: Logger;
  now?: () => Date;
};

export type WellnessSync = {
  // Pulls the last few days and upserts them (ADR-009). Returns the dates stored.
  syncRecent(): Promise<string[]>;
  // Same for the last `days` days: the one-time history import, safe to repeat.
  backfill(days: number): Promise<string[]>;
};

export function createWellnessSync(deps: WellnessSyncDeps): WellnessSync {
  const log = deps.logger.child({ module: "intervals-sync" });
  const now = deps.now ?? (() => new Date());

  async function sync(days: number): Promise<string[]> {
    const today = localDate(now(), deps.timeZone);
    const records = await deps.client.wellness(addDays(today, -(days - 1)), today);
    const stored: string[] = [];
    for (const update of records.map(healthUpdateFromWellness)) {
      if (!hasHealthValues(update)) continue;
      await deps.health.upsert(update);
      stored.push(update.date);
    }
    log.info({ days: stored.length, from: stored[0], to: stored.at(-1) }, "wellness synced");
    return stored;
  }

  return {
    syncRecent: () => sync(WELLNESS_LOOKBACK_DAYS),
    backfill: (days) => sync(days),
  };
}

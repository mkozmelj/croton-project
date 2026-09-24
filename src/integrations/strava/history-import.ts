import type { Logger } from "pino";
import type { ActivityStore } from "../../db/activities.js";
import type { StravaClient } from "./client.js";
import { activityFromStrava } from "./mapper.js";

// Strava's maximum page size. A year of training is a few pages, well inside the
// 100-requests-per-15-minutes read limit.
const PAGE_SIZE = 200;
// Stops a runaway loop if the API ever keeps returning full pages.
const MAX_PAGES = 25;

type ImportDeps = {
  client: Pick<StravaClient, "listActivities">;
  activities: Pick<ActivityStore, "insertMissing">;
  logger: Logger;
  now?: () => Date;
};

export type HistoryImportResult = { fetched: number; inserted: number };

export type StravaHistoryImport = {
  // Stores the activities of the last `days` days that aren't stored yet. No notifications;
  // repeating it only fills gaps (e.g. an activity whose webhook event was missed).
  run(days: number): Promise<HistoryImportResult>;
};

export function createStravaHistoryImport(deps: ImportDeps): StravaHistoryImport {
  const log = deps.logger.child({ module: "strava-import" });
  const now = deps.now ?? (() => new Date());

  return {
    async run(days) {
      const after = new Date(now().getTime() - days * 86_400_000);
      let fetched = 0;
      let inserted = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { items, pageLength } = await deps.client.listActivities(after, page, PAGE_SIZE);
        fetched += items.length;
        for (const item of items) {
          if (await deps.activities.insertMissing(activityFromStrava(item))) inserted++;
        }
        if (pageLength < PAGE_SIZE) break;
      }
      log.info({ days, fetched, inserted }, "strava history imported");
      return { fetched, inserted };
    },
  };
}

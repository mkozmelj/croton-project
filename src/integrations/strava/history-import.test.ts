import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { NewActivity } from "../../db/activities.js";
import type { FetchedActivity } from "./client.js";
import { createStravaHistoryImport } from "./history-import.js";
import { stravaActivity } from "./test-fixtures.js";

const NOW = new Date("2026-09-24T10:00:00Z");

function setup(pages: { items: FetchedActivity[]; pageLength: number }[], existing: string[] = []) {
  const stored = new Map<string, NewActivity>(existing.map((id) => [id, {} as NewActivity]));
  const requests: [Date, number, number][] = [];
  const importer = createStravaHistoryImport({
    client: {
      listActivities: async (after, page, perPage) => {
        requests.push([after, page, perPage]);
        return pages[page - 1] ?? { items: [], pageLength: 0 };
      },
    },
    activities: {
      insertMissing: async (activity) => {
        if (stored.has(activity.externalId)) return false;
        stored.set(activity.externalId, activity);
        return true;
      },
    },
    logger: pino({ level: "silent" }),
    now: () => NOW,
  });
  return { importer, stored, requests };
}

const fetched = (id: number): FetchedActivity => {
  const activity = stravaActivity({ id });
  return { activity, raw: activity };
};

describe("createStravaHistoryImport().run", () => {
  it("pages until a short page and only inserts what's missing", async () => {
    const full = Array.from({ length: 200 }, (_, i) => fetched(i + 1));
    const { importer, stored, requests } = setup(
      [
        { items: full, pageLength: 200 },
        { items: [fetched(500)], pageLength: 1 },
      ],
      ["1"],
    );

    expect(await importer.run(365)).toEqual({ fetched: 201, inserted: 200 });
    expect(requests.map(([, page, perPage]) => [page, perPage])).toEqual([
      [1, 200],
      [2, 200],
    ]);
    expect(requests[0]?.[0].toISOString()).toBe("2025-09-24T10:00:00.000Z");
    expect(stored.get("500")?.source).toBe("strava");
  });

  it("keeps paging when a full page had unparseable entries", async () => {
    const { importer, requests } = setup([
      { items: [fetched(1)], pageLength: 200 },
      { items: [], pageLength: 0 },
    ]);
    await importer.run(30);
    expect(requests).toHaveLength(2);
  });
});

import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { Activity, NewActivity } from "../../db/activities.js";
import { createStravaActivitySync } from "./activity-sync.js";
import type { StravaClient } from "./client.js";
import { inMemoryTokens, storedActivity, stravaActivity } from "./test-fixtures.js";
import type { StravaEvent } from "./webhook.js";

function setup(fetched = stravaActivity() as ReturnType<typeof stravaActivity> | null) {
  const rows = new Map<string, NewActivity>();
  const fetchedIds: number[] = [];
  const newActivities: Activity[] = [];
  let deauthorized = 0;
  const tokens = inMemoryTokens({
    accountId: "4242",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: new Date(),
    scope: null,
  });
  const client: Pick<StravaClient, "getActivity"> = {
    getActivity: async (id) => {
      fetchedIds.push(id);
      return fetched ? { activity: fetched, raw: fetched } : null;
    },
  };
  const sync = createStravaActivitySync({
    client,
    tokens: tokens.store,
    activities: {
      // Mirrors the real upsert: `inserted` only on the first write for an external id.
      upsert: async (activity) => {
        const inserted = !rows.has(activity.externalId);
        rows.set(activity.externalId, activity);
        return { activity: storedActivity({ externalId: activity.externalId }), inserted };
      },
      deleteByExternalId: async (externalId) => {
        rows.delete(externalId);
      },
    },
    onNewActivity: async (activity) => {
      newActivities.push(activity);
    },
    onDeauthorized: async () => {
      deauthorized += 1;
    },
    logger: pino({ level: "silent" }),
  });
  return { sync, rows, fetchedIds, newActivities, tokens, deauthorized: () => deauthorized };
}

const event = (overrides: Partial<StravaEvent> = {}): StravaEvent => ({
  object_type: "activity",
  object_id: 111,
  aspect_type: "create",
  owner_id: 4242,
  subscription_id: 5,
  event_time: 0,
  ...overrides,
});

describe("createStravaActivitySync().handle", () => {
  it("re-fetches a new activity, stores it and announces it once", async () => {
    const { sync, rows, fetchedIds, newActivities } = setup();
    await sync.handle(event());
    // Strava retries the webhook and later sends an update for a title change.
    await sync.handle(event());
    await sync.handle(event({ aspect_type: "update", updates: { title: "Renamed" } }));

    expect(fetchedIds).toEqual([111, 111, 111]);
    expect([...rows.keys()]).toEqual(["111"]);
    expect(newActivities).toHaveLength(1);
  });

  it("stores an unknown activity from an update event without announcing it", async () => {
    // e.g. the athlete renames an activity from before Strava was connected.
    const { sync, rows, newActivities } = setup();
    await sync.handle(event({ aspect_type: "update", updates: { title: "Renamed" } }));
    expect([...rows.keys()]).toEqual(["111"]);
    expect(newActivities).toEqual([]);
  });

  it("deletes the stored activity on a delete event without fetching", async () => {
    const { sync, rows, fetchedIds } = setup();
    await sync.handle(event());
    await sync.handle(event({ aspect_type: "delete" }));
    expect(rows.size).toBe(0);
    expect(fetchedIds).toEqual([111]);
  });

  it("skips an activity the API no longer returns", async () => {
    const { sync, rows, newActivities } = setup(null);
    await sync.handle(event());
    expect(rows.size).toBe(0);
    expect(newActivities).toEqual([]);
  });

  it("drops the tokens when the athlete revokes access", async () => {
    const { sync, tokens, deauthorized } = setup();
    await sync.handle(
      event({ object_type: "athlete", aspect_type: "update", updates: { authorized: "false" } }),
    );
    expect(tokens.current()).toBeNull();
    expect(deauthorized()).toBe(1);
  });
});

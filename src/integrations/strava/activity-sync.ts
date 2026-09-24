import type { Logger } from "pino";
import type { Activity, ActivityStore } from "../../db/activities.js";
import type { OAuthTokenStore } from "../../db/oauth-tokens.js";
import type { StravaClient } from "./client.js";
import { activityFromStrava } from "./mapper.js";
import type { StravaEvent } from "./webhook.js";

type SyncDeps = {
  client: StravaClient;
  activities: Pick<ActivityStore, "upsert" | "deleteByExternalId">;
  tokens: Pick<OAuthTokenStore, "remove">;
  // Called once per newly stored activity — not on updates or webhook retries.
  onNewActivity: (activity: Activity) => Promise<void>;
  onDeauthorized: () => Promise<void>;
  logger: Logger;
};

export type StravaActivitySync = {
  handle(event: StravaEvent): Promise<void>;
};

export function createStravaActivitySync(deps: SyncDeps): StravaActivitySync {
  const log = deps.logger.child({ module: "strava-sync" });

  return {
    async handle(event) {
      if (event.object_type === "athlete") {
        // The only athlete event Strava sends is a deauthorization.
        if (event.updates?.authorized === "false") {
          await deps.tokens.remove("strava");
          log.warn("athlete revoked Strava access");
          await deps.onDeauthorized();
        }
        return;
      }

      const externalId = String(event.object_id);
      if (event.aspect_type === "delete") {
        await deps.activities.deleteByExternalId(externalId);
        log.info({ externalId }, "activity deleted");
        return;
      }

      // ADR-012: never trust the payload; the API is the source of truth.
      const fetched = await deps.client.getActivity(event.object_id);
      if (!fetched) {
        log.warn({ externalId }, "activity not found (deleted or not visible), skipped");
        return;
      }
      const { activity, inserted } = await deps.activities.upsert(activityFromStrava(fetched));
      log.info({ externalId, aspect: event.aspect_type, inserted }, "activity stored");
      if (inserted) await deps.onNewActivity(activity);
    },
  };
}

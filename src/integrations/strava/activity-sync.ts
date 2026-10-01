import type { Logger } from "pino";
import type { Activity, ActivityStore } from "../../db/activities.js";
import type { OAuthTokenStore } from "../../db/oauth-tokens.js";
import type { StravaClient } from "./client.js";
import { activityFromStrava } from "./mapper.js";
import type { StravaEvent } from "./webhook.js";

type SyncDeps = {
  client: Pick<StravaClient, "getActivity" | "hasAccess">;
  activities: Pick<ActivityStore, "upsert" | "deleteByExternalId">;
  tokens: Pick<OAuthTokenStore, "remove">;
  // Called once per newly uploaded activity — not on updates or webhook retries.
  onNewActivity: (activity: Activity) => Promise<void>;
  onDeauthorized: () => Promise<void>;
  logger: Logger;
};

export type StravaActivitySync = {
  handle(event: StravaEvent): Promise<void>;
};

// ADR-012: Strava doesn't sign events, and the webhook's subscription and owner checks use
// ids that aren't secret (the athlete id is in their public profile URL). So no event is
// trusted on its own: each one is confirmed with the Strava API before anything changes.
export function createStravaActivitySync(deps: SyncDeps): StravaActivitySync {
  const log = deps.logger.child({ module: "strava-sync" });

  return {
    async handle(event) {
      if (event.object_type === "athlete") {
        // The only athlete event Strava sends is a deauthorization.
        if (event.updates?.authorized === "false") {
          if (await deps.client.hasAccess()) {
            log.warn("deauthorization event, but Strava still accepts our access: ignored");
            return;
          }
          await deps.tokens.remove("strava");
          log.warn("athlete revoked Strava access");
          await deps.onDeauthorized();
        }
        return;
      }

      const externalId = String(event.object_id);
      // ADR-012: never trust the payload; the API is the source of truth.
      const fetched = await deps.client.getActivity(event.object_id);

      if (event.aspect_type === "delete") {
        if (fetched) {
          log.warn({ externalId }, "delete event, but Strava still has the activity: ignored");
          return;
        }
        await deps.activities.deleteByExternalId(externalId);
        log.info({ externalId }, "activity deleted");
        return;
      }

      if (!fetched) {
        log.warn({ externalId }, "activity not found (deleted or not visible), skipped");
        return;
      }
      // Another athlete's activity that our token can see (e.g. a public one) isn't ours.
      if (fetched.activity.athlete?.id !== event.owner_id) {
        log.warn({ externalId }, "activity belongs to another athlete, skipped");
        return;
      }
      const { activity, inserted } = await deps.activities.upsert(activityFromStrava(fetched));
      log.info({ externalId, aspect: event.aspect_type, inserted }, "activity stored");
      // An update can insert too (an edit to an activity from before Strava was connected);
      // only a fresh upload is announced.
      if (inserted && event.aspect_type === "create") await deps.onNewActivity(activity);
    },
  };
}

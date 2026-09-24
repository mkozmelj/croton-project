import type { Logger } from "pino";
import type { FitnessService } from "../../agent/fitness.js";
import type { FitnessMarkerStore } from "../../db/fitness-markers.js";
import { latestMarkers, type Marker } from "../../training/markers.js";
import { localDate } from "../../utils/dates.js";
import type { IntervalsClient } from "./client.js";
import { markersFromIntervals, zonesFromIntervals } from "./profile-mapper.js";

type ProfileSyncDeps = {
  client: Pick<IntervalsClient, "athlete">;
  markers: Pick<FitnessMarkerStore, "list">;
  fitness: Pick<FitnessService, "record">;
  timeZone: string;
  logger: Logger;
  now?: () => Date;
};

export type ProfileSync = {
  // Imports thresholds and zones (ADR-016). Returns the markers that changed.
  sync(): Promise<Marker[]>;
};

// A new marker row only when the value differs from the latest `intervals` row, so a daily
// run adds nothing while the settings stay the same.
export function createProfileSync(deps: ProfileSyncDeps): ProfileSync {
  const log = deps.logger.child({ module: "intervals-profile" });
  const now = deps.now ?? (() => new Date());

  return {
    async sync() {
      const athlete = await deps.client.athlete();
      const today = localDate(now(), deps.timeZone);
      const previous = latestMarkers(
        (await deps.markers.list()).filter((m) => m.source === "intervals"),
      );
      const changed = markersFromIntervals(athlete, today).filter((candidate) => {
        const last = previous.find(
          (m) => m.sport === candidate.sport && m.metric === candidate.metric,
        );
        return !last || Math.abs(last.value - candidate.value) >= 0.05;
      });
      // Zones are re-derived every run: cheap, and a no-op when nothing moved.
      await deps.fitness.record(changed, zonesFromIntervals(athlete));
      log.info(
        { changed: changed.map((m) => `${m.sport}:${m.metric}=${m.value}`) },
        "intervals profile synced",
      );
      return changed;
    },
  };
}

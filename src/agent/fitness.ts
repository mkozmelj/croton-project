import type { AthleteProfileStore } from "../db/athlete-profile.js";
import type { FitnessMarkerStore, StoredMarker } from "../db/fitness-markers.js";
import { latestMarkers, type Marker } from "../training/markers.js";
import { deriveZones, intervalsZonesOf, type SportZones } from "../training/zones.js";

type FitnessDeps = {
  markers: FitnessMarkerStore;
  profile: Pick<AthleteProfileStore, "get" | "update">;
};

export type FitnessService = {
  // The current value per (sport, metric).
  latest(): Promise<StoredMarker[]>;
  // Writes the markers, then re-derives `sport_zones` (ADR-016). `intervalsZones` are fresh
  // Intervals.icu zone sets; without them the stored snapshot's Intervals.icu sets are reused.
  record(markers: readonly Marker[], intervalsZones?: SportZones): Promise<void>;
};

export function createFitnessService(deps: FitnessDeps): FitnessService {
  return {
    async latest() {
      return latestMarkers(await deps.markers.list());
    },

    async record(markers, intervalsZones) {
      for (const marker of markers) await deps.markers.upsert(marker);
      const [all, profile] = await Promise.all([deps.markers.list(), deps.profile.get()]);
      const zones = deriveZones(
        latestMarkers(all),
        intervalsZones ?? intervalsZonesOf(profile?.sportZones),
      );
      if (JSON.stringify(zones) !== JSON.stringify(profile?.sportZones ?? {})) {
        await deps.profile.update({ sportZones: zones });
      }
    },
  };
}

import { desc } from "drizzle-orm";
import type { Marker } from "../training/markers.js";
import type { Database } from "./client.js";
import { fitnessMarkers } from "./schema.js";

export type StoredMarker = typeof fitnessMarkers.$inferSelect;

export type FitnessMarkerStore = {
  // Every marker, newest first (measured_on, then written). The table stays small: a few
  // rows per threshold change per season.
  list(): Promise<StoredMarker[]>;
  // ADR-009: upsert on (sport, metric, measured_on, source).
  upsert(marker: Marker): Promise<void>;
};

export function createFitnessMarkerStore(db: Database): FitnessMarkerStore {
  return {
    async list() {
      return db
        .select()
        .from(fitnessMarkers)
        .orderBy(
          desc(fitnessMarkers.measuredOn),
          desc(fitnessMarkers.createdAt),
          desc(fitnessMarkers.id),
        );
    },

    async upsert(marker) {
      const values = {
        sport: marker.sport,
        metric: marker.metric,
        value: marker.value,
        measuredOn: marker.measuredOn,
        source: marker.source,
        sourceRef: marker.sourceRef ?? null,
        notes: marker.notes ?? null,
      };
      await db
        .insert(fitnessMarkers)
        .values(values)
        .onConflictDoUpdate({
          target: [
            fitnessMarkers.sport,
            fitnessMarkers.metric,
            fitnessMarkers.measuredOn,
            fitnessMarkers.source,
          ],
          set: { value: values.value, sourceRef: values.sourceRef, notes: values.notes },
        });
    },
  };
}

import type { Database } from "./client.js";
import { athleteProfile } from "./schema.js";

export type AthleteProfile = typeof athleteProfile.$inferSelect;

// Read-only until the Phase 5 onboarding flow fills it in.
export type AthleteProfileStore = {
  get(): Promise<AthleteProfile | null>;
};

export function createAthleteProfileStore(db: Database): AthleteProfileStore {
  return {
    async get() {
      const [row] = await db.select().from(athleteProfile).limit(1);
      return row ?? null;
    },
  };
}

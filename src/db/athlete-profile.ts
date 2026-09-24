import type { Database } from "./client.js";
import { athleteProfile } from "./schema.js";

export type AthleteProfile = typeof athleteProfile.$inferSelect;

export type AthleteProfileChanges = Partial<
  Pick<AthleteProfile, "name" | "sportZones" | "background" | "injuryNotes" | "preferences">
>;

export type AthleteProfileStore = {
  get(): Promise<AthleteProfile | null>;
  // Upserts the single row; only the given columns change.
  update(changes: AthleteProfileChanges): Promise<void>;
};

export function createAthleteProfileStore(db: Database): AthleteProfileStore {
  return {
    async get() {
      const [row] = await db.select().from(athleteProfile).limit(1);
      return row ?? null;
    },

    async update(changes) {
      const defined = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      ) as AthleteProfileChanges;
      await db
        .insert(athleteProfile)
        .values({ id: 1, ...defined })
        .onConflictDoUpdate({
          target: athleteProfile.id,
          set: { ...defined, updatedAt: new Date() },
        });
    },
  };
}

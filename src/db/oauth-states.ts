import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "./client.js";
import type { OAuthProvider } from "./oauth-tokens.js";
import { oauthStates } from "./schema.js";

// ADR-011: a state is valid for 10 minutes and can be consumed once.
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthStateStore = {
  create(provider: OAuthProvider): Promise<string>;
  // True while the state exists and hasn't expired. Doesn't consume it.
  isLive(state: string, provider: OAuthProvider): Promise<boolean>;
  // Deletes the state and returns whether it was live — a second call returns false.
  consume(state: string, provider: OAuthProvider): Promise<boolean>;
};

export function createOAuthStateStore(db: Database, now = () => new Date()): OAuthStateStore {
  const matches = (state: string, provider: OAuthProvider) =>
    and(
      eq(oauthStates.state, state),
      eq(oauthStates.provider, provider),
      gt(oauthStates.expiresAt, now()),
    );

  return {
    async create(provider) {
      // Expired states are never consumed; clear them out whenever a new one is made.
      await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now()));
      const state = randomBytes(24).toString("base64url");
      await db.insert(oauthStates).values({
        state,
        provider,
        expiresAt: new Date(now().getTime() + OAUTH_STATE_TTL_MS),
      });
      return state;
    },

    async isLive(state, provider) {
      const rows = await db
        .select({ state: oauthStates.state })
        .from(oauthStates)
        .where(matches(state, provider));
      return rows.length > 0;
    },

    async consume(state, provider) {
      // A single DELETE … RETURNING, so two concurrent callbacks can't both succeed.
      const rows = await db
        .delete(oauthStates)
        .where(matches(state, provider))
        .returning({ state: oauthStates.state });
      return rows.length > 0;
    },
  };
}

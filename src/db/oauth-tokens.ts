import { eq } from "drizzle-orm";
import type { TokenCipher } from "../integrations/oauth-crypto.js";
import type { Database } from "./client.js";
import { oauthTokens } from "./schema.js";

export type OAuthProvider = (typeof oauthTokens.$inferSelect)["provider"];

// Plaintext tokens. Encryption happens inside the store, so nothing else handles ciphertext.
export type OAuthTokenSet = {
  accountId: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string | null;
};

export type OAuthTokenStore = {
  get(provider: OAuthProvider): Promise<OAuthTokenSet | null>;
  // ADR-011: every save writes both tokens — a refresh may rotate the refresh token.
  save(provider: OAuthProvider, tokens: OAuthTokenSet): Promise<void>;
  remove(provider: OAuthProvider): Promise<void>;
};

export function createOAuthTokenStore(db: Database, cipher: TokenCipher): OAuthTokenStore {
  return {
    async get(provider) {
      const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.provider, provider));
      if (!row) return null;
      return {
        accountId: row.accountId,
        accessToken: cipher.decrypt(row.accessToken),
        refreshToken: cipher.decrypt(row.refreshToken),
        expiresAt: row.expiresAt,
        scope: row.scope,
      };
    },

    async save(provider, tokens) {
      const values = {
        accountId: tokens.accountId,
        accessToken: cipher.encrypt(tokens.accessToken),
        refreshToken: cipher.encrypt(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
      };
      await db
        .insert(oauthTokens)
        .values({ provider, ...values })
        .onConflictDoUpdate({
          target: oauthTokens.provider,
          set: { ...values, updatedAt: new Date() },
        });
    },

    async remove(provider) {
      await db.delete(oauthTokens).where(eq(oauthTokens.provider, provider));
    },
  };
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ADR-011: OAuth tokens are AES-256-GCM encrypted at rest. Stored format:
// `v1.<iv>.<auth tag>.<ciphertext>`, each part base64url. The version prefix leaves room
// for key rotation without guessing which rows use which key.
const VERSION = "v1";
const IV_BYTES = 12;

export class TokenDecryptionError extends Error {
  override readonly name = "TokenDecryptionError";
}

export type TokenCipher = {
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
};

export function createTokenCipher(base64Key: string): TokenCipher {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, iv, cipher.getAuthTag(), ciphertext]
        .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
        .join(".");
    },

    decrypt(stored) {
      const [version, iv, tag, ciphertext, ...rest] = stored.split(".");
      if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length > 0) {
        throw new TokenDecryptionError("unrecognized encrypted token format");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        // Wrong key or tampered data. Never include the stored value in the message.
        throw new TokenDecryptionError("token decryption failed", { cause: error });
      }
    },
  };
}

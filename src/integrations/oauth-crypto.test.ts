import { describe, expect, it } from "vitest";
import { createTokenCipher, TokenDecryptionError } from "./oauth-crypto.js";

const key = Buffer.alloc(32, 1).toString("base64");

describe("createTokenCipher", () => {
  it("round-trips a token", () => {
    const cipher = createTokenCipher(key);
    expect(cipher.decrypt(cipher.encrypt("fake-access-token"))).toBe("fake-access-token");
  });

  it("never stores the plaintext and uses a fresh IV each time", () => {
    const cipher = createTokenCipher(key);
    const a = cipher.encrypt("fake-access-token");
    const b = cipher.encrypt("fake-access-token");
    expect(a).not.toContain("fake-access-token");
    expect(a).not.toBe(b);
  });

  it("rejects a tampered ciphertext", () => {
    const cipher = createTokenCipher(key);
    const [version, iv, tag, data = ""] = cipher.encrypt("fake-access-token").split(".");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const tampered = [version, iv, tag, flipped.toString("base64url")].join(".");
    expect(() => cipher.decrypt(tampered)).toThrow(TokenDecryptionError);
  });

  it("rejects decryption with a different key", () => {
    const stored = createTokenCipher(key).encrypt("fake-access-token");
    const other = createTokenCipher(Buffer.alloc(32, 2).toString("base64"));
    expect(() => other.decrypt(stored)).toThrow(TokenDecryptionError);
  });

  it("rejects values that aren't in the stored format", () => {
    expect(() => createTokenCipher(key).decrypt("plain-token")).toThrow(TokenDecryptionError);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => createTokenCipher(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});

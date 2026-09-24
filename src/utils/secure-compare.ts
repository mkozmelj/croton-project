import { createHash, timingSafeEqual } from "node:crypto";

// ADR-012: constant-time secret comparison. Hashing first makes both sides equal length,
// so neither a length mismatch nor the comparison itself leaks timing.
export function secureEquals(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || received.length === 0) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

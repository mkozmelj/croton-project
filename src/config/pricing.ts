import { MODELS, type ModelId } from "./env.js";

// ADR-008: per-model pricing in USD per million tokens. Review together with MODELS on every bump.
// Checked 2026-09-26 against platform.claude.com/docs/en/about-claude/pricing: Sonnet 5's launch
// price ($2/$10) became its standard price; the planned rise to $3/$15 was cancelled.
// Sonnet 5.5 (2026-10-01) kept Sonnet 5's prices and cache rates.
// Thinking tokens bill as output tokens (ADR-005).
export type ModelPricing = {
  inputPerMTok: number;
  outputPerMTok: number;
};

export const PRICING: Record<ModelId, ModelPricing> = {
  [MODELS.sonnet]: { inputPerMTok: 2, outputPerMTok: 10 },
  [MODELS.haiku]: { inputPerMTok: 1, outputPerMTok: 5 },
};

// ADR-014: text-embedding-3-small, USD per million input tokens (no output tokens).
export const EMBEDDING_PRICE_PER_MTOK = 0.02;

// Prompt-cache multipliers on the base input price.
export const CACHE_MULTIPLIERS = {
  write5m: 1.25,
  write1h: 2,
  read: 0.1,
} as const;

// The budget is in EUR, the API bills in USD. Deliberately on the high side so the
// tracked spend overestimates rather than underestimates. Update if EUR/USD moves a lot.
export const USD_TO_EUR = 0.92;

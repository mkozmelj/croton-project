import { MODELS, type ModelId } from "./env.js";

// ADR-008: per-model pricing in USD per million tokens. Review together with MODELS on every bump.
// Thinking tokens bill as output tokens (ADR-005).
export type ModelPricing = {
  inputPerMTok: number;
  outputPerMTok: number;
};

export const PRICING: Record<ModelId, ModelPricing> = {
  [MODELS.sonnet]: { inputPerMTok: 3, outputPerMTok: 15 },
  [MODELS.haiku]: { inputPerMTok: 1, outputPerMTok: 5 },
};

// Prompt-cache multipliers on the base input price.
export const CACHE_MULTIPLIERS = {
  write5m: 1.25,
  write1h: 2,
  read: 0.1,
} as const;

// The budget is in EUR, the API bills in USD. Deliberately on the high side so the
// tracked spend overestimates rather than underestimates. Update if EUR/USD moves a lot.
export const USD_TO_EUR = 0.92;

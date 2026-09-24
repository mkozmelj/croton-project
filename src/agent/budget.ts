import type { Usage } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ModelId } from "../config/env.js";
import { CACHE_MULTIPLIERS, PRICING, USD_TO_EUR } from "../config/pricing.js";

// spec.md §8.3 graduated enforcement, as fractions of the monthly cap
// (the spec's €10.50 / €12.60 / €13.50 / €14.00 on a €14 cap).
export type BudgetLevel = "normal" | "warning" | "haiku_only" | "minimal" | "stopped";

const THRESHOLDS: readonly { fraction: number; level: Exclude<BudgetLevel, "normal"> }[] = [
  { fraction: 0.75, level: "warning" },
  { fraction: 0.9, level: "haiku_only" },
  { fraction: 13.5 / 14, level: "minimal" },
  { fraction: 1, level: "stopped" },
];

export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";

  constructor(
    readonly level: "minimal" | "stopped",
    readonly spendEur: number,
  ) {
    super(`LLM budget level ${level} (spent €${spendEur.toFixed(2)}), call refused`);
  }
}

type BillableUsage = Pick<
  Usage,
  | "input_tokens"
  | "output_tokens"
  | "cache_creation_input_tokens"
  | "cache_read_input_tokens"
  | "cache_creation"
>;

export function calculateCostEur(model: ModelId, usage: BillableUsage): number {
  const { inputPerMTok, outputPerMTok } = PRICING[model];
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
  // Without a TTL breakdown, assume the pricier 1h write so spend is never underestimated.
  const cacheWrite5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const cacheWrite1h = usage.cache_creation
    ? usage.cache_creation.ephemeral_1h_input_tokens
    : cacheWriteTotal;

  const inputEquivalentTokens =
    usage.input_tokens +
    cacheWrite5m * CACHE_MULTIPLIERS.write5m +
    cacheWrite1h * CACHE_MULTIPLIERS.write1h +
    cacheRead * CACHE_MULTIPLIERS.read;

  const usd = (inputEquivalentTokens * inputPerMTok + usage.output_tokens * outputPerMTok) / 1e6;
  return usd * USD_TO_EUR;
}

export function budgetLevel(spendEur: number, capEur: number): BudgetLevel {
  let level: BudgetLevel = "normal";
  for (const threshold of THRESHOLDS) {
    if (spendEur >= threshold.fraction * capEur) level = threshold.level;
  }
  return level;
}

// Levels newly reached by moving from `beforeEur` to `afterEur` — each fires one alert.
export function crossedLevels(beforeEur: number, afterEur: number, capEur: number): BudgetLevel[] {
  return THRESHOLDS.filter(
    ({ fraction }) => beforeEur < fraction * capEur && afterEur >= fraction * capEur,
  ).map(({ level }) => level);
}

import { describe, expect, it } from "vitest";
import { MODELS } from "../config/env.js";
import { USD_TO_EUR } from "../config/pricing.js";
import { budgetLevel, calculateCostEur, crossedLevels } from "./budget.js";

const noCache = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: null,
};

describe("calculateCostEur", () => {
  it("prices plain Sonnet input and output", () => {
    const cost = calculateCostEur(MODELS.sonnet, {
      ...noCache,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo((2 + 10) * USD_TO_EUR, 6);
  });

  it("prices Haiku with its own rates", () => {
    const cost = calculateCostEur(MODELS.haiku, {
      ...noCache,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo((1 + 5) * USD_TO_EUR, 6);
  });

  it("applies cache write (1h = 2x, 5m = 1.25x) and read (0.1x) multipliers", () => {
    const cost = calculateCostEur(MODELS.sonnet, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000,
      cache_creation: {
        ephemeral_1h_input_tokens: 1_000_000,
        ephemeral_5m_input_tokens: 1_000_000,
      },
    });
    expect(cost).toBeCloseTo(2 * (0.1 + 2 + 1.25) * USD_TO_EUR, 6);
  });

  it("assumes the 1h write price when the TTL breakdown is missing", () => {
    const cost = calculateCostEur(MODELS.sonnet, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: null,
    });
    expect(cost).toBeCloseTo(2 * 2 * USD_TO_EUR, 6);
  });
});

describe("budgetLevel", () => {
  it.each([
    [0, "normal"],
    [10.49, "normal"],
    [10.5, "warning"],
    [12.6, "haiku_only"],
    [13.5, "minimal"],
    [14, "stopped"],
    [20, "stopped"],
  ] as const)("€%s of €14 is %s", (spend, expected) => {
    expect(budgetLevel(spend, 14)).toBe(expected);
  });
});

describe("crossedLevels", () => {
  it("returns nothing when no threshold is crossed", () => {
    expect(crossedLevels(1, 2, 14)).toEqual([]);
  });

  it("returns each threshold crossed by a single call", () => {
    expect(crossedLevels(10, 12.7, 14)).toEqual(["warning", "haiku_only"]);
  });

  it("does not re-fire a threshold that was already crossed", () => {
    expect(crossedLevels(10.6, 11, 14)).toEqual([]);
  });
});

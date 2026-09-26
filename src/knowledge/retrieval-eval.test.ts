import { describe, expect, it } from "vitest";
import { EMBEDDING_MODEL } from "../config/env.js";
import {
  dequantize,
  EVAL_K,
  loadEvalCase,
  measureRecall,
  quantize,
  readCache,
} from "./retrieval-eval.js";

// ADR-014 retrieval eval. Measured 2026-09-26 at recall@5 1.00, top-1 0.94 (18 questions);
// the floors leave room for one miss, so a chunking change that costs two fails here.
const MIN_RECALL = 0.9;
const MIN_TOP1 = 0.8;

describe("retrieval eval", () => {
  it(`finds the expected source in the top ${EVAL_K} for the fixture questions`, async () => {
    const evalCase = await loadEvalCase();
    const cache = await readCache();
    expect(cache?.model, "embeddings.json is missing or stale: run npm run eval:embed").toBe(
      EMBEDDING_MODEL,
    );
    const uncached = [...evalCase.texts.keys()].filter((key) => !cache?.vectors[key]);
    expect(
      uncached,
      "chunking or fixtures changed since the cache was built: run npm run eval:embed",
    ).toEqual([]);

    const report = measureRecall(evalCase, (key) => dequantize(cache?.vectors[key] ?? ""), EVAL_K);
    const misses = JSON.stringify(report.misses, null, 2);
    expect(report.recall, misses).toBeGreaterThanOrEqual(MIN_RECALL);
    expect(report.top1).toBeGreaterThanOrEqual(MIN_TOP1);
  });
});

describe("quantized vectors", () => {
  it("round-trip with the same direction", () => {
    const vector = [0.12, -0.5, 0.03, 0.25];
    const back = dequantize(quantize(vector));
    expect(back).toEqual([30, -127, 8, 64]);
  });
});

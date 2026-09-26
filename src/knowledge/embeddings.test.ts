import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../db/llm-usage.js";
import { createOpenAIEmbedder, EmbeddingError, embeddingCostEur } from "./embeddings.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(responses: Response[]) {
  const requests: { input: string[] }[] = [];
  const usage: UsageRecord[] = [];
  const embedder = createOpenAIEmbedder({
    apiKey: "test-key",
    usage: { record: async (row) => void usage.push(row) },
    timeZone: "Europe/Ljubljana",
    now: () => new Date("2026-09-26T10:00:00Z"),
    sleep: async () => {},
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as { input: string[] });
      const next = responses.shift();
      if (!next) throw new Error("no response scripted");
      return next;
    },
  });
  return { embedder, requests, usage };
}

const ok = (count: number, offset = 0) =>
  json({
    // Out of order on purpose: results are matched by index.
    data: Array.from({ length: count }, (_, i) => ({
      index: i,
      embedding: [offset + i],
    })).reverse(),
    usage: { prompt_tokens: count * 10 },
  });

describe("createOpenAIEmbedder", () => {
  it("batches inputs, keeps order and logs usage per request", async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const { embedder, requests, usage } = setup([ok(96), ok(4, 96)]);
    const vectors = await embedder.embed(texts);
    expect(requests.map((r) => r.input.length)).toEqual([96, 4]);
    expect(vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    expect(usage).toEqual([
      expect.objectContaining({
        callType: "embedding",
        model: "text-embedding-3-small",
        inputTokens: 960,
        outputTokens: 0,
        date: "2026-09-26",
      }),
      expect.objectContaining({ inputTokens: 40 }),
    ]);
  });

  it("retries rate limits and server errors", async () => {
    const { embedder } = setup([json({}, 429), json({}, 503), ok(1)]);
    expect(await embedder.embed(["x"])).toEqual([[0]]);
  });

  it("fails fast on a bad key", async () => {
    const { embedder, requests } = setup([json({ error: { message: "Incorrect API key" } }, 401)]);
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
    expect(requests).toHaveLength(1);
  });

  it("prices at $0.02 per million tokens", () => {
    expect(embeddingCostEur(1_000_000)).toBeCloseTo(0.02 * 0.92);
  });
});

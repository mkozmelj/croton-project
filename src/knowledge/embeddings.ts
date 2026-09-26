import { z } from "zod";
import { EMBEDDING_MODEL } from "../config/env.js";
import { EMBEDDING_PRICE_PER_MTOK, USD_TO_EUR } from "../config/pricing.js";
import type { UsageStore } from "../db/llm-usage.js";
import { localDate } from "../utils/dates.js";

// OpenAI embeddings over REST (ADR-014). Every request is logged to llm_usage as
// call_type 'embedding', so it counts toward the monthly budget like any Claude call.

export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";
}

const API_URL = "https://api.openai.com/v1/embeddings";
// OpenAI accepts up to 2048 inputs per request; smaller batches keep a retry cheap.
const BATCH_SIZE = 96;
const MAX_ATTEMPTS = 3;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number().int() }),
});

export type Embedder = {
  readonly model: string;
  // One vector per text, in order.
  embed(texts: readonly string[]): Promise<number[][]>;
};

type EmbedderDeps = {
  apiKey: string;
  usage: Pick<UsageStore, "record">;
  timeZone: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export function embeddingCostEur(tokens: number): number {
  return ((tokens * EMBEDDING_PRICE_PER_MTOK) / 1e6) * USD_TO_EUR;
}

export function createOpenAIEmbedder(deps: EmbedderDeps): Embedder {
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function embedBatch(input: string[]): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      const response = await request(API_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
      });
      if (response.ok) {
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) throw new EmbeddingError("OpenAI returned an unexpected body");
        const { data, usage } = parsed.data;
        await deps.usage.record({
          date: localDate(now(), deps.timeZone),
          model: EMBEDDING_MODEL,
          callType: "embedding",
          inputTokens: usage.prompt_tokens,
          outputTokens: 0,
          costEur: embeddingCostEur(usage.prompt_tokens),
        });
        const vectors = [...data].sort((a, b) => a.index - b.index).map((row) => row.embedding);
        if (vectors.length !== input.length) {
          throw new EmbeddingError(`asked for ${input.length} embeddings, got ${vectors.length}`);
        }
        return vectors;
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        // The body names the problem (bad key, quota); it never echoes the key back.
        const detail = (await response.text()).slice(0, 300);
        throw new EmbeddingError(`OpenAI embeddings returned ${response.status}: ${detail}`);
      }
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }

  return {
    model: EMBEDDING_MODEL,
    async embed(texts) {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        vectors.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
      }
      return vectors;
    },
  };
}

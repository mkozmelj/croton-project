// Refreshes the retrieval eval's embedding cache (ADR-014): embeds only the fixture chunks and
// questions not cached yet, drops the ones no longer used, then prints the recall.
//   npm run eval:embed
// Commit the updated src/knowledge/eval-fixtures/embeddings.json.
import { writeFile } from "node:fs/promises";
import { EMBEDDING_MODEL, env } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { createUsageStore } from "../db/llm-usage.js";
import { createOpenAIEmbedder } from "./embeddings.js";
import {
  dequantize,
  EMBEDDINGS_FILE,
  EVAL_K,
  loadEvalCase,
  measureRecall,
  quantize,
  readCache,
} from "./retrieval-eval.js";

if (!env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set");
  process.exit(1);
}

const evalCase = await loadEvalCase();
const previous = await readCache();
const cached = previous?.model === EMBEDDING_MODEL ? previous.vectors : {};
const missing = [...evalCase.texts].filter(([key]) => !cached[key]);

const embedder = createOpenAIEmbedder({
  apiKey: env.OPENAI_API_KEY,
  usage: createUsageStore(createDatabase(env.DATABASE_URL)),
  timeZone: env.TIMEZONE,
});
const vectors = await embedder.embed(missing.map(([, text]) => text));

const next: Record<string, string> = {};
for (const key of [...evalCase.texts.keys()].sort()) {
  const fresh = missing.findIndex(([missingKey]) => missingKey === key);
  const vector = fresh >= 0 ? vectors[fresh] : undefined;
  const encoded = vector ? quantize(vector) : cached[key];
  if (encoded) next[key] = encoded;
}
await writeFile(
  EMBEDDINGS_FILE,
  `${JSON.stringify({ model: EMBEDDING_MODEL, vectors: next }, null, 2)}\n`,
);

const report = measureRecall(evalCase, (key) => dequantize(next[key] ?? ""), EVAL_K);
console.log(
  `${missing.length} embedded, ${Object.keys(next).length} cached. ${evalCase.chunks.length} chunks, ${evalCase.questions.length} questions.`,
);
console.log(`recall@${EVAL_K} ${report.recall.toFixed(2)}, top-1 ${report.top1.toFixed(2)}`);
for (const miss of report.misses) console.log(`MISS ${miss.query} → ${miss.got.join(", ")}`);

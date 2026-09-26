// Literature ingest (ADR-014). Local only; source files live in git-ignored data/literature/.
//   npm run ingest -- <file> --source "Seiler 2010" --type paper   (paper | article | book_scan | notes)
//   npm run ingest -- <file> --source "..." --type ... --dry-run   (print chunks, no DB, no OpenAI)
//   npm run ingest -- --list                                        (sources and chunk counts)
// Keep --source identical between runs of the same file: it is half of the idempotency key.
import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { createLiteratureStore } from "../db/literature.js";
import { createUsageStore } from "../db/llm-usage.js";
import { LITERATURE_SOURCE_TYPES } from "../db/schema.js";
import { estimateTokens } from "./chunk.js";
import { createOpenAIEmbedder, embeddingCostEur } from "./embeddings.js";
import { extractBlocks } from "./extract.js";
import { ingest, prepareChunks, type SourceType } from "./ingest.js";

const USAGE =
  'usage: npm run ingest -- <file> --source "<name>" --type paper|article|book_scan|notes [--dry-run]\n       npm run ingest -- --list';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: "string" },
    type: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
  },
});

const isSourceType = (value: string | undefined): value is SourceType =>
  (LITERATURE_SOURCE_TYPES as readonly string[]).includes(value ?? "");

const db = createDatabase(env.DATABASE_URL);
const store = createLiteratureStore(db);

if (values.list) {
  for (const row of await store.sources()) {
    console.log(`${String(row.chunks).padStart(5)}  ${row.sourceType.padEnd(9)}  ${row.source}`);
  }
  process.exit(0);
}

const [file] = positionals;
const { source } = values;
if (!file || !source || !isSourceType(values.type)) {
  console.error(USAGE);
  process.exit(1);
}
const sourceType = values.type;

const blocks = await extractBlocks(file);

if (values["dry-run"]) {
  const chunks = prepareChunks(blocks, source, sourceType);
  for (const [i, chunk] of chunks.entries()) {
    const where = [chunk.chapter, chunk.section, chunk.locator].filter(Boolean).join(" | ");
    console.log(`\n#${i + 1} [${estimateTokens(chunk.text)} tok] ${where}`);
    console.log(`${chunk.content.slice(0, 240).replace(/\s+/g, " ")}…`);
  }
  const tokens = chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0);
  console.log(
    `\n${chunks.length} chunks, ~${tokens} tokens, ~€${embeddingCostEur(tokens).toFixed(4)} to embed. Dry run: nothing written.`,
  );
  process.exit(0);
}

if (!env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set");
  process.exit(1);
}
const embedder = createOpenAIEmbedder({
  apiKey: env.OPENAI_API_KEY,
  usage: createUsageStore(db),
  timeZone: env.TIMEZONE,
});
const result = await ingest({ store, embedder }, { blocks, source, sourceType });
console.log(
  `${source}: ${result.chunks} chunks (${result.embedded} embedded, ${result.unchanged} unchanged, ${result.removed} stale removed).`,
);

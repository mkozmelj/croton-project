// ADR-021 backfill: gives stored sessions that only have a fallback type (planned before
// session types existed, or imported from TrainingPeaks) a real session type and intensity,
// one Haiku call per batch. Safe to repeat: a session the model can't place keeps its type.
//   npm run workouts:classify -- --dry-run
//   npm run workouts:classify

import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import pino from "pino";
import { env } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { createUsageStore } from "../db/llm-usage.js";
import { createBackfillStore } from "../db/planned-workout-backfill.js";
import { createClaude } from "./claude.js";
import { classifySessions, FALLBACK_TYPES } from "./session-classifier.js";

const BATCH = 40;
const MAX_ROWS = 2_000;

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });

const db = createDatabase(env.DATABASE_URL);
const store = createBackfillStore(db);
const claude = createClaude({
  messages: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).messages,
  usage: createUsageStore(db),
  logger: pino({ level: "warn" }),
  monthlyBudgetEur: env.MONTHLY_LLM_BUDGET_EUR,
  timeZone: env.TIMEZONE,
  disableThinking: env.DISABLE_THINKING,
});

const rows = await store.withTypes(FALLBACK_TYPES, MAX_ROWS);
console.log(`${rows.length} sessions with a fallback type.`);
let changed = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const result = await classifySessions(claude, batch);
  for (const row of batch) {
    const found = result.get(row.id);
    if (!found || FALLBACK_TYPES.includes(found.sessionType)) continue;
    console.log(
      `  ${row.id} ${row.sport} "${row.title}" → ${found.sessionType}, ${found.intensity}`,
    );
    if (!values["dry-run"]) {
      await store.setClassification(row.id, found.sessionType, found.intensity);
    }
    changed++;
  }
}
console.log(
  values["dry-run"]
    ? `Dry run: ${changed} sessions would get a type.`
    : `${changed} sessions classified.`,
);

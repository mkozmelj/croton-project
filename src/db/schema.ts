import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ADR-003: `content` is the full Anthropic content-block array, exactly as sent/received.
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: jsonb("content").$type<ContentBlockParam[]>().notNull(),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    tokensUsed: integer("tokens_used"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_created_at_idx").on(table.createdAt)],
);

// One row per Claude API call. `date` is the local (TIMEZONE) calendar date, so the
// monthly budget resets at local midnight on the 1st.
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: serial("id").primaryKey(),
    date: date("date", { mode: "string" }).notNull(),
    model: text("model").notNull(),
    callType: text("call_type").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    costEur: numeric("cost_eur", { precision: 10, scale: 6, mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("llm_usage_date_idx").on(table.date)],
);

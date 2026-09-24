CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"telegram_message_id" bigint,
	"tokens_used" integer,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"model" text NOT NULL,
	"call_type" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_eur" numeric(10, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversations_created_at_idx" ON "conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_date_idx" ON "llm_usage" USING btree ("date");
CREATE TABLE "conversation_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"through_turn_id" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"summary" text NOT NULL,
	"turn_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_memories_through_turn_id_unique" UNIQUE("through_turn_id")
);

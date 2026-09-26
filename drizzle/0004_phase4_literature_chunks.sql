CREATE TABLE "literature_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_type" text NOT NULL,
	"chapter" text,
	"section" text,
	"locator" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "literature_chunks_source_hash" ON "literature_chunks" USING btree ("source","content_hash");
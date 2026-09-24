CREATE TABLE "fitness_markers" (
	"id" serial PRIMARY KEY NOT NULL,
	"sport" text NOT NULL,
	"metric" text NOT NULL,
	"value" numeric NOT NULL,
	"measured_on" date NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"action_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"phase" text,
	"plan" jsonb NOT NULL,
	"recap_notes" text,
	"agent_analysis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_plans_week_start_unique" UNIQUE("week_start")
);
--> statement-breakpoint
ALTER TABLE "athlete_profile" ADD COLUMN "background" jsonb;--> statement-breakpoint
ALTER TABLE "health_metrics" ADD COLUMN "ctl" numeric;--> statement-breakpoint
ALTER TABLE "health_metrics" ADD COLUMN "atl" numeric;--> statement-breakpoint
ALTER TABLE "health_metrics" ADD COLUMN "ramp_rate" numeric;--> statement-breakpoint
CREATE UNIQUE INDEX "fitness_markers_sport_metric_day_source" ON "fitness_markers" USING btree ("sport","metric","measured_on","source");--> statement-breakpoint
CREATE INDEX "pending_actions_chat_idx" ON "pending_actions" USING btree ("chat_id","action_type");
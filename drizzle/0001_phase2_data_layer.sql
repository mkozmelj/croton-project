CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"sport" text NOT NULL,
	"name" text,
	"started_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer NOT NULL,
	"elapsed_seconds" integer,
	"distance_meters" numeric,
	"elevation_gain_meters" numeric,
	"avg_hr" integer,
	"max_hr" integer,
	"avg_pace_per_km" numeric,
	"avg_power" numeric,
	"training_load" numeric,
	"zone_distribution" jsonb,
	"laps" jsonb,
	"notes" text,
	"raw_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "athlete_profile" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text,
	"sport_zones" jsonb,
	"vdot" numeric,
	"ftp" numeric,
	"css" numeric,
	"injury_notes" text,
	"preferences" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_profile_single_row" CHECK ("athlete_profile"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"sport" text NOT NULL,
	"distance" text,
	"location" text,
	"calendar_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"season" integer NOT NULL,
	"priority" text NOT NULL,
	"goal_type" text NOT NULL,
	"target" text,
	"target_seconds" integer,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_priority_valid" CHECK ("goals"."priority" in ('A', 'B', 'C')),
	CONSTRAINT "goals_status_valid" CHECK ("goals"."status" in ('active', 'achieved', 'missed', 'dropped'))
);
--> statement-breakpoint
CREATE TABLE "health_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"sleep_duration_minutes" integer,
	"sleep_quality_score" numeric,
	"deep_sleep_minutes" integer,
	"rem_sleep_minutes" integer,
	"resting_hr" integer,
	"hrv_ms" numeric,
	"body_battery" integer,
	"stress_avg" integer,
	"weight_kg" numeric,
	"body_fat_pct" numeric,
	"muscle_mass_kg" numeric,
	"bmi" numeric,
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_metrics_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"provider" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_started_at_idx" ON "activities" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "events_date_idx" ON "events" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_one_active_a_per_season" ON "goals" USING btree ("season") WHERE "goals"."priority" = 'A' and "goals"."status" = 'active';
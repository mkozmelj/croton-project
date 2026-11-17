CREATE TABLE "planned_workouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"week_start" date NOT NULL,
	"date" date NOT NULL,
	"start_time" text NOT NULL,
	"sport" text NOT NULL,
	"session_type" text NOT NULL,
	"title" text NOT NULL,
	"intensity" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"active_minutes" integer NOT NULL,
	"structure" jsonb NOT NULL,
	"steps" jsonb,
	"targets" text,
	"field_test" text,
	"notes" text,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"status_source" text,
	"activity_id" integer,
	"brick_with" integer,
	"replaced_by" integer,
	"calendar_event_id" text,
	"source" text DEFAULT 'plan' NOT NULL,
	"main_set" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planned_workouts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_brick_with_planned_workouts_id_fk" FOREIGN KEY ("brick_with") REFERENCES "public"."planned_workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_replaced_by_planned_workouts_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."planned_workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planned_workouts_week_idx" ON "planned_workouts" USING btree ("week_start");--> statement-breakpoint
CREATE INDEX "planned_workouts_date_idx" ON "planned_workouts" USING btree ("date");--> statement-breakpoint
CREATE INDEX "planned_workouts_type_date_idx" ON "planned_workouts" USING btree ("session_type","date");--> statement-breakpoint
CREATE UNIQUE INDEX "planned_workouts_activity_idx" ON "planned_workouts" USING btree ("activity_id") WHERE "planned_workouts"."activity_id" is not null;--> statement-breakpoint
-- ADR-021: a copy of every stored weekly plan before its sessions move to planned_workouts
-- (src/db/legacy-plans.ts, on boot). Not in schema.ts; dropped one release later.
CREATE TABLE "training_plans_workouts_backup" AS SELECT "week_start", "plan", now() AS "copied_at" FROM "training_plans";

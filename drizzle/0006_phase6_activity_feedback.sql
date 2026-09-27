CREATE TABLE "activity_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer NOT NULL,
	"rpe" integer,
	"rpe_source" text,
	"feel" text,
	"pain" boolean,
	"pain_note" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_feedback_activity_id_unique" UNIQUE("activity_id"),
	CONSTRAINT "activity_feedback_rpe_range" CHECK ("activity_feedback"."rpe" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "activity_feedback" ADD CONSTRAINT "activity_feedback_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;
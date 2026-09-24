-- ADR-016: carry any stored thresholds over as markers before the columns go. Their real
-- measurement date is unknown; the profile's last update is the best available.
INSERT INTO "fitness_markers" ("sport", "metric", "value", "measured_on", "source", "notes")
SELECT m.sport, m.metric, m.value, (p."updated_at" AT TIME ZONE 'Europe/Ljubljana')::date, 'athlete_reported', 'moved from athlete_profile'
FROM "athlete_profile" p
CROSS JOIN LATERAL (VALUES ('run', 'vdot', p."vdot"), ('bike', 'ftp_w', p."ftp"), ('swim', 'css_s_per_100m', p."css")) AS m(sport, metric, value)
WHERE m.value IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "athlete_profile" DROP COLUMN "vdot";--> statement-breakpoint
ALTER TABLE "athlete_profile" DROP COLUMN "ftp";--> statement-breakpoint
ALTER TABLE "athlete_profile" DROP COLUMN "css";
import { z } from "zod";

// ADR-016: the athlete's training background, collected by the chat onboarding. Stored as
// `athlete_profile.background` (jsonb) and validated with this schema on the way in and out.

export const raceResultSchema = z.object({
  date: z.iso.date(),
  event: z.string().min(1),
  sport: z.enum(["run", "trail_run", "bike", "swim", "triathlon", "other"]),
  distance_meters: z.number().positive().nullable(),
  time_seconds: z.number().int().positive().nullable(),
  notes: z.string().nullable(),
});

export type RaceResult = z.infer<typeof raceResultSchema>;

export const backgroundSchema = z.object({
  years_by_sport: z.array(z.object({ sport: z.string().min(1), years: z.number().nonnegative() })),
  typical_weekly_hours: z.number().nonnegative().nullable(),
  recent_results: z.array(raceResultSchema),
  notes: z.string().nullable(),
});

export type Background = z.infer<typeof backgroundSchema>;

// A stored value that doesn't parse (hand-edited, older shape) is treated as missing.
export function parseBackground(value: unknown): Background | null {
  const parsed = backgroundSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

import { z } from "zod";
import type { Activity } from "../db/activities.js";
import type { ActivityFeedbackStore } from "../db/activity-feedback.js";
import type { TrainingPlanStore } from "../db/training-plans.js";
import type { Workout } from "../training/plan.js";
import { matchPlannedWorkout } from "../training/plan-match.js";
import { localDate, weekStart } from "../utils/dates.js";

// ADR-018: what the bot asks after a new activity. The rules are a first guess, to revisit
// after a few weeks of use.

export const FEEDBACK_QUESTIONS = ["rpe", "feel", "pain", "note"] as const;
export type FeedbackQuestion = (typeof FEEDBACK_QUESTIONS)[number];

// An activity that ends longer ago than this when it arrives (a late sync) gets no questions.
export const FEEDBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LONG_SESSION_SECONDS = 90 * 60;
const EASY_INTENSITIES: ReadonlySet<Workout["intensity"]> = new Set(["recovery", "easy"]);

type QuestionInput = {
  startedAt: Date;
  durationSeconds: number;
  planned: Workout | undefined;
  // A field-test or breakthrough marker was proposed for this activity.
  markerProposed: boolean;
  // The activity already has an RPE (from Strava).
  rpeKnown: boolean;
  now: Date;
};

// The full set for key sessions (a planned non-easy workout, a long one, a test or
// breakthrough), RPE and a note button otherwise. Empty when nothing is left to ask.
export function questionsFor(input: QuestionInput): FeedbackQuestion[] {
  const endedAt = input.startedAt.getTime() + input.durationSeconds * 1000;
  if (input.now.getTime() - endedAt > FEEDBACK_MAX_AGE_MS) return [];
  const key =
    input.markerProposed ||
    input.durationSeconds >= LONG_SESSION_SECONDS ||
    (input.planned !== undefined && !EASY_INTENSITIES.has(input.planned.intensity));
  const questions: FeedbackQuestion[] = key ? ["rpe", "feel", "pain", "note"] : ["rpe", "note"];
  const asked = input.rpeKnown ? questions.filter((q) => q !== "rpe") : questions;
  // A note button alone isn't worth a message.
  return asked.some((q) => q !== "note") ? asked : [];
}

// Strava's perceived exertion, when the athlete set it in the Strava app. Not in Strava's
// published API reference, so it's read defensively; anything outside 1-10 is ignored.
const stravaExertion = z.object({ perceived_exertion: z.number().nullish() });

export function stravaRpe(raw: unknown): number | null {
  const parsed = stravaExertion.safeParse(raw);
  const value = parsed.success ? parsed.data.perceived_exertion : null;
  if (value == null) return null;
  const rpe = Math.round(value);
  return rpe >= 1 && rpe <= 10 ? rpe : null;
}

type RequesterDeps = {
  plans: Pick<TrainingPlanStore, "forWeek">;
  feedback: Pick<ActivityFeedbackStore, "set">;
  timeZone: string;
  now?: () => Date;
};

export type FeedbackRequester = {
  // Stores an RPE the activity already carries and returns the questions to ask.
  prepare(activity: Activity, markerProposed: boolean): Promise<FeedbackQuestion[]>;
};

export function createFeedbackRequester(deps: RequesterDeps): FeedbackRequester {
  const now = deps.now ?? (() => new Date());
  return {
    async prepare(activity, markerProposed) {
      const rpe = stravaRpe(activity.rawData);
      if (rpe !== null) await deps.feedback.set(activity.id, { rpe, rpeSource: "strava" });
      const plan = await deps.plans.forWeek(
        weekStart(localDate(activity.startedAt, deps.timeZone)),
      );
      return questionsFor({
        startedAt: activity.startedAt,
        durationSeconds: activity.durationSeconds,
        planned: matchPlannedWorkout(activity, plan?.plan.workouts ?? [], deps.timeZone),
        markerProposed,
        rpeKnown: rpe !== null,
        now: now(),
      });
    },
  };
}

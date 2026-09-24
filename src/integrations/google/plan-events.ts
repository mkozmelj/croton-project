import { createHash } from "node:crypto";
import type { Workout } from "../../training/plan.js";
import { APP_EVENT_PROPERTY, type EventBody } from "./calendar.js";

const ICONS: Record<Workout["sport"], string> = {
  run: "🏃",
  trail_run: "⛰️",
  bike: "🚴",
  swim: "🏊",
  brick: "🚴🏃",
  strength: "🏋️",
  tennis: "🎾",
  mobility: "🧘",
  other: "💪",
};

// Deterministic event id per (booking, workout): a retried booking upserts the same events
// instead of duplicating them. Only 0-9 and a-v are allowed (base32hex); hex fits.
export function workoutEventId(bookingKey: string, index: number): string {
  const digest = createHash("sha256").update(`${bookingKey}:${index}`).digest("hex");
  return `croton${digest.slice(0, 32)}`;
}

// "2026-09-29" + "07:00" + 55 min → "2026-09-29T07:55:00" (naive local time; Google applies
// the event's timeZone, so no offset arithmetic and no DST mistakes here).
export function addMinutesLocal(date: string, time: string, minutes: number): string {
  const naive = new Date(`${date}T${time}:00Z`);
  naive.setUTCMinutes(naive.getUTCMinutes() + minutes);
  return naive.toISOString().slice(0, 19);
}

export function workoutEvent(workout: Workout, timeZone: string): EventBody {
  const lines = workout.structure.map((s) => `${s.segment}: ${s.description}`);
  if (workout.targets) lines.push(`Targets: ${workout.targets}`);
  if (workout.notes) lines.push("", workout.notes);
  return {
    summary: `${ICONS[workout.sport]} ${workout.title} (${workout.duration_minutes} min)`,
    description: lines.join("\n"),
    start: { dateTime: `${workout.date}T${workout.start_time}:00`, timeZone },
    end: {
      dateTime: addMinutesLocal(workout.date, workout.start_time, workout.duration_minutes),
      timeZone,
    },
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    extendedProperties: { private: { ...APP_EVENT_PROPERTY } },
  };
}

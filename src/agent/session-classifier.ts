import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ClassifiableRow } from "../db/planned-workout-backfill.js";
import { workoutSchema } from "../training/plan.js";
import {
  isBrickType,
  SESSION_TYPE_GUIDE,
  SESSION_TYPES,
  type SessionType,
  sessionTypeFits,
} from "../training/session-types.js";
import type { Claude } from "./claude.js";
import { textOf } from "./history.js";

// ADR-021 backfill: one Haiku call per batch of stored sessions that only have a fallback
// type (sessions planned before session types existed). Rows and titles are data, not
// instructions.

// The types a backfilled row starts with. tennis and mobility are final as they are.
export const FALLBACK_TYPES: readonly SessionType[] = [
  "other",
  "other_run",
  "other_bike",
  "other_swim",
  "other_strength",
];

const INTENSITY = workoutSchema.shape.intensity;

const outputSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.number().int(),
      session_type: z.enum(SESSION_TYPES),
      intensity: INTENSITY,
    }),
  ),
});

export type Classification = { sessionType: SessionType; intensity: z.infer<typeof INTENSITY> };

const TEXT_LIMIT = 300;

function describe(row: ClassifiableRow): string {
  const structure = Array.isArray(row.structure)
    ? row.structure
        .map((s: unknown) =>
          typeof s === "object" && s !== null && "description" in s ? String(s.description) : "",
        )
        .join(" | ")
    : "";
  return JSON.stringify({
    id: row.id,
    sport: row.sport,
    title: row.title,
    minutes: row.durationMinutes,
    structure: structure.slice(0, TEXT_LIMIT),
    notes: row.notes?.slice(0, TEXT_LIMIT) ?? null,
  });
}

export async function classifySessions(
  claude: Pick<Claude, "call">,
  rows: readonly ClassifiableRow[],
): Promise<Map<number, Classification>> {
  if (rows.length === 0) return new Map();
  const prompt = [
    "Classify each planned training session below by its session type and intensity.",
    `Session types: ${SESSION_TYPE_GUIDE}.`,
    "Pick a type that fits the session's sport. Use the other_* type for the sport (or other) when the title and structure don't say enough. Never use a brick_* type: these are single sessions. Use field_test only for a field test, race only for a race.",
    "intensity: recovery, easy, moderate, hard or race, from the title and structure.",
    "Return one entry per session, with its id.",
    "<sessions>",
    ...rows.map(describe),
    "</sessions>",
  ].join("\n");
  const { message } = await claude.call({
    callType: "session_classification",
    messages: [{ role: "user", content: prompt }],
    outputFormat: zodOutputFormat(outputSchema),
  });
  const parsed = outputSchema.safeParse(safeJson(textOf(message.content)));
  if (!parsed.success) return new Map();

  const sports = new Map(rows.map((r) => [r.id, r.sport]));
  const result = new Map<number, Classification>();
  for (const entry of parsed.data.sessions) {
    const sport = sports.get(entry.id);
    if (sport === undefined || isBrickType(entry.session_type)) continue;
    if (!sessionTypeFits(entry.session_type, sport)) continue;
    result.set(entry.id, { sessionType: entry.session_type, intensity: entry.intensity });
  }
  return result;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

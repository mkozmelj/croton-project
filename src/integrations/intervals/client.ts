import { z } from "zod";
import { timeoutSignal } from "../../utils/http.js";

const API_BASE = "https://intervals.icu/api/v1";

export class IntervalsApiError extends Error {
  override readonly name = "IntervalsApiError";

  constructor(
    readonly status: number,
    path: string,
  ) {
    super(
      status === 401 || status === 403
        ? `Intervals.icu rejected the API key (${status}) for ${path}`
        : `Intervals.icu ${path} returned ${status}`,
    );
  }
}

const num = z.number().finite().nullish();

// One day of Intervals.icu wellness (its OpenAPI `Wellness` schema, checked 2026-09-24).
// `id` is the local date. Loose object: custom wellness fields (e.g. a Garmin Body Battery
// field, if the sync provides one) arrive as extra keys and are kept.
export const wellnessSchema = z.looseObject({
  id: z.iso.date(),
  restingHR: num,
  hrv: num,
  sleepSecs: num,
  sleepScore: num,
  stress: num,
  weight: num,
  bodyFat: num,
  // ADR-016: Intervals.icu's fitness / fatigue / ramp rate (computed from its activities).
  ctl: num,
  atl: num,
  rampRate: num,
  updated: z.string().nullish(),
});

export type Wellness = z.infer<typeof wellnessSchema>;

const numbers = z.array(z.number()).nullish();

// One entry of the athlete's `sportSettings` (units recorded in test-fixtures.ts, ADR-016).
export const sportSettingsSchema = z.looseObject({
  types: z.array(z.string()),
  ftp: num,
  lthr: num,
  max_hr: num,
  threshold_pace: num, // m/s
  hr_zones: numbers, // absolute bpm, upper bounds
  hr_zone_names: z.array(z.string()).nullish(),
  power_zones: numbers, // % of FTP, upper bounds, 999 = open
  power_zone_names: z.array(z.string()).nullish(),
});

export type SportSettings = z.infer<typeof sportSettingsSchema>;

export const athleteSchema = z.looseObject({
  id: z.string(),
  icu_resting_hr: num,
  sportSettings: z.array(sportSettingsSchema).default([]),
});

export type IntervalsAthlete = z.infer<typeof athleteSchema>;

// Personal API key: HTTP basic auth with the literal username `API_KEY`. Exported so the
// logger can scrub the encoded form too.
export function intervalsBasicCredentials(apiKey: string): string {
  return Buffer.from(`API_KEY:${apiKey}`).toString("base64");
}

export type IntervalsClient = {
  // Wellness records for local dates `oldest`..`newest` (inclusive, YYYY-MM-DD).
  wellness(oldest: string, newest: string): Promise<Wellness[]>;
  // The athlete record with per-sport thresholds and zones.
  athlete(): Promise<IntervalsAthlete>;
};

export function createIntervalsClient({
  apiKey,
  athleteId,
  fetch: doFetch = fetch,
}: {
  apiKey: string;
  athleteId: string;
  fetch?: typeof fetch;
}): IntervalsClient {
  const authorization = `Basic ${intervalsBasicCredentials(apiKey)}`;

  async function get(path: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(`${API_BASE}${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const response = await doFetch(url, {
      headers: { authorization, accept: "application/json" },
      signal: timeoutSignal(),
    });
    if (!response.ok) throw new IntervalsApiError(response.status, path);
    return response.json();
  }

  return {
    async wellness(oldest, newest) {
      const body = await get(`/athlete/${athleteId}/wellness`, { oldest, newest });
      return z.array(wellnessSchema).parse(body);
    },

    async athlete() {
      return athleteSchema.parse(await get(`/athlete/${athleteId}`));
    },
  };
}

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
  updated: z.string().nullish(),
});

export type Wellness = z.infer<typeof wellnessSchema>;

// Personal API key: HTTP basic auth with the literal username `API_KEY`. Exported so the
// logger can scrub the encoded form too.
export function intervalsBasicCredentials(apiKey: string): string {
  return Buffer.from(`API_KEY:${apiKey}`).toString("base64");
}

export type IntervalsClient = {
  // Wellness records for local dates `oldest`..`newest` (inclusive, YYYY-MM-DD).
  wellness(oldest: string, newest: string): Promise<Wellness[]>;
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

  return {
    async wellness(oldest, newest) {
      const path = `/athlete/${athleteId}/wellness`;
      const url = new URL(`${API_BASE}${path}`);
      url.search = new URLSearchParams({ oldest, newest }).toString();
      const response = await doFetch(url, {
        headers: { authorization, accept: "application/json" },
        signal: timeoutSignal(),
      });
      if (!response.ok) throw new IntervalsApiError(response.status, path);
      return z.array(wellnessSchema).parse(await response.json());
    },
  };
}

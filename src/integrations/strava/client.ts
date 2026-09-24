import { z } from "zod";
import { timeoutSignal } from "../../utils/http.js";
import { type StravaAuth, StravaAuthError } from "./oauth.js";

const API_BASE = "https://www.strava.com/api/v3";

export class StravaApiError extends Error {
  override readonly name = "StravaApiError";

  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Strava API ${path} returned ${status}`);
  }
}

// The fields of Strava's DetailedActivity this app reads. Everything else stays in raw_data.
const lapSchema = z.object({
  name: z.string().nullish(),
  elapsed_time: z.number(),
  moving_time: z.number(),
  distance: z.number(),
  average_heartrate: z.number().nullish(),
  average_watts: z.number().nullish(),
});

export const stravaActivitySchema = z.object({
  id: z.number().int(),
  name: z.string().nullish(),
  sport_type: z.string(),
  start_date: z.iso.datetime(),
  moving_time: z.number().int(),
  elapsed_time: z.number().int().nullish(),
  distance: z.number().nullish(),
  total_elevation_gain: z.number().nullish(),
  average_heartrate: z.number().nullish(),
  max_heartrate: z.number().nullish(),
  average_watts: z.number().nullish(),
  weighted_average_watts: z.number().nullish(),
  suffer_score: z.number().nullish(),
  description: z.string().nullish(),
  laps: z.array(lapSchema).nullish(),
});

export type StravaActivity = z.infer<typeof stravaActivitySchema>;

export type FetchedActivity = { activity: StravaActivity; raw: unknown };

export type StravaClient = {
  // Null when the activity no longer exists or isn't visible with the granted scope.
  getActivity(id: number): Promise<FetchedActivity | null>;
  // One page of the athlete's activities started after `after`, oldest first. Summary
  // records: no laps or description (those only come from getActivity). `pageLength` counts
  // every entry on the page, including any skipped as unparseable (for paging).
  listActivities(
    after: Date,
    page: number,
    perPage: number,
  ): Promise<{ items: FetchedActivity[]; pageLength: number }>;
};

export function createStravaClient({
  auth,
  fetch: doFetch = fetch,
}: {
  auth: Pick<StravaAuth, "accessToken">;
  fetch?: typeof fetch;
}): StravaClient {
  async function get(path: string): Promise<Response> {
    const response = await doFetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${await auth.accessToken()}` },
      signal: timeoutSignal(),
    });
    if (response.status === 401) throw new StravaAuthError("Strava rejected the access token");
    return response;
  }

  return {
    async getActivity(id) {
      const path = `/activities/${id}`;
      const response = await get(path);
      if (response.status === 404) return null;
      if (!response.ok) throw new StravaApiError(response.status, path);
      const raw: unknown = await response.json();
      return { activity: stravaActivitySchema.parse(raw), raw };
    },

    async listActivities(after, page, perPage) {
      const query = new URLSearchParams({
        after: String(Math.floor(after.getTime() / 1000)),
        page: String(page),
        per_page: String(perPage),
      });
      const path = `/athlete/activities?${query}`;
      const response = await get(path);
      if (!response.ok) throw new StravaApiError(response.status, "/athlete/activities");
      const items = z.array(z.unknown()).parse(await response.json());
      // An entry that doesn't parse (an odd manual activity) is skipped, not fatal.
      const parsed = items.flatMap((raw) => {
        const result = stravaActivitySchema.safeParse(raw);
        return result.success ? [{ activity: result.data, raw }] : [];
      });
      return { items: parsed, pageLength: items.length };
    },
  };
}

import { z } from "zod";
import { timeoutSignal } from "../../utils/http.js";
import type { GoogleAuth } from "./oauth.js";

const API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export class GoogleCalendarError extends Error {
  override readonly name = "GoogleCalendarError";

  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`Google Calendar ${operation} returned ${status}`);
  }
}

// Marks events this app created, so they can be told apart from the athlete's own.
export const APP_EVENT_PROPERTY = { croton: "workout" } as const;

const eventTimeSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
});

const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  start: eventTimeSchema.optional(),
  end: eventTimeSchema.optional(),
  transparency: z.string().optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
});

export type CalendarEvent = z.infer<typeof eventSchema>;

export type EventBody = {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: { useDefault: boolean; overrides: { method: "popup"; minutes: number }[] };
  extendedProperties: { private: Record<string, string> };
};

export type CalendarClient = {
  // Events overlapping [from, to), recurring events expanded, cancelled ones skipped.
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  // Creates the event with this id, or replaces it when it exists — so a retried booking
  // never creates a duplicate. `id`: 5-1024 chars of a-v and 0-9 (base32hex).
  upsertEvent(id: string, body: EventBody): Promise<void>;
  // Deleting an event that's already gone is fine.
  deleteEvent(id: string): Promise<void>;
};

export function createCalendarClient({
  auth,
  fetch: doFetch = fetch,
}: {
  auth: Pick<GoogleAuth, "accessToken">;
  fetch?: typeof fetch;
}): CalendarClient {
  async function request(url: string | URL, init: RequestInit = {}) {
    return doFetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${await auth.accessToken()}`,
        "content-type": "application/json",
        ...init.headers,
      },
      signal: timeoutSignal(),
    });
  }

  return {
    async listEvents(from, to) {
      const url = new URL(API_BASE);
      url.search = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      }).toString();
      const response = await request(url);
      if (!response.ok) throw new GoogleCalendarError(response.status, "list");
      const body = z
        .object({ items: z.array(eventSchema).default([]) })
        .parse(await response.json());
      return body.items.filter((event) => event.status !== "cancelled");
    },

    async upsertEvent(id, body) {
      const created = await request(API_BASE, {
        method: "POST",
        body: JSON.stringify({ id, ...body }),
      });
      if (created.ok) return;
      // 409: the id exists (a retry, or a deleted event, which keeps its id) — replace it.
      if (created.status !== 409) throw new GoogleCalendarError(created.status, "insert");
      const replaced = await request(`${API_BASE}/${id}`, {
        method: "PUT",
        body: JSON.stringify({ ...body, status: "confirmed" }),
      });
      if (!replaced.ok) throw new GoogleCalendarError(replaced.status, "update");
    },

    async deleteEvent(id) {
      const response = await request(`${API_BASE}/${id}`, { method: "DELETE" });
      if (response.ok || response.status === 404 || response.status === 410) return;
      throw new GoogleCalendarError(response.status, "delete");
    },
  };
}

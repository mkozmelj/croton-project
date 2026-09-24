import type { Logger } from "pino";
import { APP_EVENT_PROPERTY, type CalendarClient } from "../integrations/google/calendar.js";
import { addDays, localMidnight } from "../utils/dates.js";

type CalendarContextDeps = {
  calendar: () => Promise<CalendarClient | null>;
  timeZone: string;
  logger: Logger;
};

export type CalendarContext = {
  // The athlete's own events in the week (not the workouts this app booked), one line each.
  // null when the calendar isn't connected or can't be read: planning goes on without it.
  weekLines(weekStart: string): Promise<string[] | null>;
};

const formatter = (timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

export function createCalendarContext(deps: CalendarContextDeps): CalendarContext {
  const log = deps.logger.child({ module: "calendar-context" });
  return {
    async weekLines(weekStart) {
      try {
        const calendar = await deps.calendar();
        if (!calendar) return null;
        const events = await calendar.listEvents(
          localMidnight(weekStart, deps.timeZone),
          localMidnight(addDays(weekStart, 7), deps.timeZone),
        );
        const format = formatter(deps.timeZone);
        return events
          .filter((e) => e.extendedProperties?.private?.croton !== APP_EVENT_PROPERTY.croton)
          .filter((e) => e.transparency !== "transparent")
          .map((e) => {
            const title = JSON.stringify(e.summary ?? "(busy)");
            if (e.start?.date) return `- ${e.start.date} all day: ${title}`;
            const start = e.start?.dateTime ? format.format(new Date(e.start.dateTime)) : "?";
            const end = e.end?.dateTime ? format.format(new Date(e.end.dateTime)).slice(-5) : "?";
            return `- ${start}-${end}: ${title}`;
          });
      } catch (error) {
        log.warn({ err: error }, "could not read the calendar for planning");
        return null;
      }
    },
  };
}

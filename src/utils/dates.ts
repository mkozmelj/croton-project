// Calendar date (YYYY-MM-DD) of `instant` in an IANA timezone — never a fixed offset.
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

// Offset (ms) of `timeZone` from UTC at `instant`, e.g. +2h for Ljubljana in summer.
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

// The instant local midnight starts on `isoDate` in `timeZone`. DST changes in Europe
// happen at night, never at midnight, so midnight always exists exactly once.
export function localMidnight(isoDate: string, timeZone: string): Date {
  const naive = Date.parse(`${isoDate}T00:00:00Z`);
  const guess = naive - zoneOffsetMs(new Date(naive), timeZone);
  // Re-check at the guess, in case the offset differs between the two instants.
  return new Date(naive - zoneOffsetMs(new Date(guess), timeZone));
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Monday of the week containing `isoDate` (training weeks run Monday to Sunday).
export function weekStart(isoDate: string): string {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(isoDate, -((weekday + 6) % 7));
}

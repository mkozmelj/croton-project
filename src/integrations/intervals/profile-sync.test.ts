import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { StoredMarker } from "../../db/fitness-markers.js";
import type { Marker } from "../../training/markers.js";
import { athleteSchema } from "./client.js";
import { createProfileSync } from "./profile-sync.js";
import { intervalsAthlete } from "./test-fixtures.js";

function setup() {
  const rows: StoredMarker[] = [];
  let athlete = intervalsAthlete();
  const sync = createProfileSync({
    client: { athlete: async () => athleteSchema.parse(athlete) },
    markers: { list: async () => [...rows].reverse() },
    fitness: {
      record: async (markers: readonly Marker[]) => {
        for (const m of markers) {
          rows.push({
            ...m,
            id: rows.length + 1,
            sourceRef: null,
            notes: null,
            createdAt: new Date(),
          });
        }
      },
    },
    timeZone: "Europe/Ljubljana",
    logger: pino({ level: "silent" }),
    now: () => new Date("2026-09-24T04:00:00Z"),
  });
  return {
    sync,
    rows,
    setAthlete: (next: ReturnType<typeof intervalsAthlete>) => {
      athlete = next;
    },
  };
}

describe("createProfileSync().sync", () => {
  it("adds markers on the first run and nothing on a second identical run", async () => {
    const { sync, rows } = setup();
    expect((await sync.sync()).length).toBe(7);
    expect(await sync.sync()).toEqual([]);
    expect(rows.length).toBe(7);
  });

  it("adds only the value that changed", async () => {
    const { sync, setAthlete } = setup();
    await sync.sync();
    const next = intervalsAthlete();
    const [bike] = next.sportSettings;
    if (bike) bike.ftp = 260;
    setAthlete(next);
    expect((await sync.sync()).map((m) => [m.metric, m.value])).toEqual([["ftp_w", 260]]);
  });
});

import { describe, expect, it } from "vitest";
import type { Workout } from "./plan.js";
import { replacements } from "./plan-revisions.js";

const session = (overrides: Partial<Workout>): Workout => ({
  date: "2026-11-19",
  start_time: "07:00",
  sport: "run",
  session_type: "run_threshold",
  brick_with_previous: false,
  title: "Threshold",
  duration_minutes: 50,
  intensity: "hard",
  structure: [],
  steps: null,
  targets: null,
  field_test: null,
  notes: null,
  ...overrides,
});

const TODAY = "2026-11-18";

describe("replacements", () => {
  it("points a moved session to the same type on the nearest day", () => {
    const old = [session({ id: 1 })];
    const incoming = [
      { key: "far", workout: session({ date: "2026-11-22" }) },
      { key: "near", workout: session({ date: "2026-11-20" }) },
    ];
    expect(replacements(old, incoming, TODAY)).toEqual([
      { id: 1, status: "replaced", successorKey: "near" },
    ]);
  });

  it("falls back to the same day and sport, and gives each successor to one session", () => {
    const old = [
      session({ id: 1, session_type: "run_easy" }),
      session({ id: 2, session_type: "run_easy", date: "2026-11-21" }),
    ];
    const incoming = [{ key: "a", workout: session({ session_type: "run_tempo" }) }];
    expect(replacements(old, incoming, TODAY)).toEqual([
      { id: 1, status: "replaced", successorKey: "a" },
      { id: 2, status: "replaced", successorKey: null },
    ]);
  });

  it("counts a session dropped on its own day as skipped", () => {
    expect(replacements([session({ id: 1, date: TODAY })], [], TODAY)).toEqual([
      { id: 1, status: "skipped", successorKey: null },
    ]);
  });

  it("ignores sessions that aren't stored yet", () => {
    expect(replacements([session({})], [], TODAY)).toEqual([]);
  });
});

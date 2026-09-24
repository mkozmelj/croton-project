import { describe, expect, it } from "vitest";
import { hasHealthValues, healthUpdateFromWellness } from "./mapper.js";

// Obviously fake values (ADR-013).
describe("healthUpdateFromWellness", () => {
  it("maps a full record, keyed by its local date", () => {
    const update = healthUpdateFromWellness({
      id: "2026-09-24",
      sleepSecs: 25_230,
      sleepScore: 80,
      hrv: 55.5,
      restingHR: 49.6,
      stress: 24.4,
      weight: 70.2,
      bodyFat: 15.1,
      ctl: 40.5,
      atl: 45.2,
      rampRate: -1.5,
    });
    expect(update).toMatchObject({
      date: "2026-09-24",
      source: "intervals",
      values: {
        sleepDurationMinutes: 421,
        sleepQualityScore: 80,
        hrvMs: 55.5,
        restingHr: 50,
        stressAvg: 24,
        weightKg: 70.2,
        bodyFatPct: 15.1,
        bodyBattery: undefined,
        ctl: 40.5,
        atl: 45.2,
        rampRate: -1.5,
      },
    });
  });

  it("leaves nulls undefined so they don't overwrite stored values", () => {
    const update = healthUpdateFromWellness({ id: "2026-09-24", hrv: 50, weight: null });
    expect(update.values.hrvMs).toBe(50);
    expect(update.values.weightKg).toBeUndefined();
    expect(hasHealthValues(update)).toBe(true);
  });

  it.each(["BodyBattery", "bodyBattery", "body_battery"])("picks up a %s custom field", (key) => {
    expect(healthUpdateFromWellness({ id: "2026-09-24", [key]: 87.4 }).values.bodyBattery).toBe(87);
  });

  it("recognizes a record with nothing to store", () => {
    const update = healthUpdateFromWellness({ id: "2026-09-24", updated: "2026-09-24T06:00:00Z" });
    expect(hasHealthValues(update)).toBe(false);
  });
});

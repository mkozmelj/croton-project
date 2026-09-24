import { describe, expect, it } from "vitest";
import { parseTerraPayload, withoutSamples } from "./parser.js";

const TZ = "Europe/Ljubljana";

// Obviously fake values (ADR-013).
const sleep = (end: string, asleepSeconds: number) => ({
  metadata: { start_time: "2026-09-23T22:30:00+02:00", end_time: end },
  sleep_durations_data: {
    asleep: {
      duration_asleep_state_seconds: asleepSeconds,
      duration_deep_sleep_state_seconds: 3600,
      duration_REM_sleep_state_seconds: 5400,
    },
  },
  scores: { sleep: 80 },
  heart_rate_data: { summary: { avg_hrv_rmssd: 55.5, resting_hr_bpm: 50 }, detailed: {} },
});

describe("parseTerraPayload", () => {
  it("maps a sleep to the local date it ends on", () => {
    const result = parseTerraPayload(
      { type: "sleep", data: [sleep("2026-09-24T06:30:00+02:00", 25_200)] },
      TZ,
    );
    expect(result).toMatchObject({
      kind: "metrics",
      updates: [
        {
          date: "2026-09-24",
          source: "sleep",
          values: {
            sleepDurationMinutes: 420,
            deepSleepMinutes: 60,
            remSleepMinutes: 90,
            sleepQualityScore: 80,
            hrvMs: 55.5,
          },
        },
      ],
    });
  });

  it("uses the local date, not the UTC one", () => {
    // 23:30 UTC on the 23rd is 01:30 on the 24th in Ljubljana.
    const result = parseTerraPayload(
      { type: "sleep", data: [sleep("2026-09-23T23:30:00Z", 3600)] },
      TZ,
    );
    expect(result.kind === "metrics" && result.updates[0]?.date).toBe("2026-09-24");
  });

  it("keeps the longest sleep when a nap lands on the same date", () => {
    const result = parseTerraPayload(
      {
        type: "sleep",
        data: [
          sleep("2026-09-24T06:30:00+02:00", 25_200),
          sleep("2026-09-24T15:00:00+02:00", 1_800),
        ],
      },
      TZ,
    );
    expect(result.kind === "metrics" && result.updates).toHaveLength(1);
    expect(result.kind === "metrics" && result.updates[0]?.values.sleepDurationMinutes).toBe(420);
  });

  it("maps daily resting HR, stress and the peak Body Battery, leaving HRV to sleep", () => {
    const result = parseTerraPayload(
      {
        type: "daily",
        data: [
          {
            metadata: {
              start_time: "2026-09-24T00:00:00+02:00",
              end_time: "2026-09-25T00:00:00+02:00",
            },
            heart_rate_data: { summary: { resting_hr_bpm: 49.6, avg_hrv_rmssd: 40 } },
            stress_data: {
              avg_stress_level: 24.4,
              body_battery_samples: [{ level: 30 }, { level: 88 }, { level: 60 }],
            },
          },
        ],
      },
      TZ,
    );
    expect(result).toMatchObject({
      kind: "metrics",
      updates: [{ date: "2026-09-24", values: { restingHr: 50, stressAvg: 24, bodyBattery: 88 } }],
    });
    expect(result.kind === "metrics" && result.updates[0]?.values).not.toHaveProperty("hrvMs");
  });

  it("maps body measurements, muscle mass in kg", () => {
    const result = parseTerraPayload(
      {
        type: "body",
        data: [
          {
            metadata: {
              start_time: "2026-09-24T07:00:00+02:00",
              end_time: "2026-09-24T07:01:00+02:00",
            },
            measurements_data: {
              day_avg_weight_kg: 70,
              day_avg_bodyfat_percentage: 15,
              day_avg_muscle_mass_g: 33_333,
              day_avg_bmi: 22,
            },
          },
        ],
      },
      TZ,
    );
    expect(result).toMatchObject({
      kind: "metrics",
      updates: [{ values: { weightKg: 70, bodyFatPct: 15, muscleMassKg: 33.3, bmi: 22 } }],
    });
  });

  it("leaves missing fields undefined so they don't overwrite stored values", () => {
    const result = parseTerraPayload(
      { type: "body", data: [{ metadata: { start_time: "2026-09-24T07:00:00Z" } }] },
      TZ,
    );
    const values = result.kind === "metrics" ? result.updates[0]?.values : undefined;
    expect(Object.values(values ?? {}).every((value) => value === undefined)).toBe(true);
  });

  it("recognizes auth events and ignores other types", () => {
    expect(
      parseTerraPayload({ type: "auth", status: "success", user: { provider: "GARMIN" } }, TZ),
    ).toEqual({ kind: "auth", type: "auth", status: "success", provider: "GARMIN" });
    expect(parseTerraPayload({ type: "activity", data: [] }, TZ)).toEqual({
      kind: "ignored",
      type: "activity",
    });
  });

  it("throws on a payload without a type", () => {
    expect(() => parseTerraPayload({ data: [] }, TZ)).toThrow();
  });
});

describe("withoutSamples", () => {
  it("drops sample arrays at any depth and keeps summaries", () => {
    expect(
      withoutSamples({
        heart_rate_data: { summary: { avg: 1 }, detailed: { hr_samples: [1, 2] } },
        stress_data: { body_battery_samples: [{ level: 1 }], avg_stress_level: 3 },
      }),
    ).toEqual({
      heart_rate_data: { summary: { avg: 1 }, detailed: {} },
      stress_data: { avg_stress_level: 3 },
    });
  });
});

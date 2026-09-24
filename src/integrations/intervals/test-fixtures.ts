// The shape of `GET /api/v1/athlete/{id}` as checked against a real response on 2026-09-24
// (ADR-016), with fake values (ADR-013). What the real response showed:
// - `sportSettings[]` has one entry per group of activity `types`, including an "Other" group.
// - `threshold_pace` is metres per second, whatever `pace_units` says (a swim value of
//   0.8333 m/s displays as 2:00 /100 m). null when unset.
// - `power_zones` are % of FTP, upper bounds, the last one 999 (= open-ended).
// - `hr_zones` are absolute bpm, upper bounds, the last one equal to max HR.
// - `pace_zones` were null for every sport, so their encoding is unverified: pace zones are
//   always computed in code (src/training/zones.ts), never read from Intervals.icu.
// - `icu_resting_hr` and `icu_weight` are on the athlete record, not per sport.
// The real response has ~150 more top-level keys (integrations, notification settings);
// the client ignores them.
export function intervalsAthlete() {
  return {
    id: "i00000",
    icu_resting_hr: 50,
    icu_weight: 70,
    timezone: "Europe/Ljubljana",
    sportSettings: [
      {
        id: 1,
        types: ["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "TrackRide", "Cyclocross"],
        ftp: 250,
        indoor_ftp: null,
        power_zones: [55, 75, 90, 105, 120, 150, 999],
        power_zone_names: [
          "Active Recovery",
          "Endurance",
          "Tempo",
          "Threshold",
          "VO2 Max",
          "Anaerobic",
          "Neuromuscular",
        ],
        lthr: 170,
        max_hr: 190,
        hr_zones: [137, 153, 160, 169, 175, 179, 190],
        hr_zone_names: [
          "Recovery",
          "Aerobic",
          "Tempo",
          "SubThreshold",
          "SuperThreshold",
          "Aerobic Capacity",
          "Anaerobic",
        ],
        threshold_pace: null,
        pace_units: null,
        pace_zones: null,
        pace_zone_names: null,
      },
      {
        id: 2,
        types: ["Run", "VirtualRun", "TrailRun"],
        ftp: null,
        power_zones: null,
        power_zone_names: null,
        lthr: 172,
        max_hr: 190,
        hr_zones: [145, 153, 162, 171, 176, 181, 190],
        hr_zone_names: [
          "Recovery",
          "Aerobic",
          "Tempo",
          "SubThreshold",
          "SuperThreshold",
          "Aerobic Capacity",
          "Anaerobic",
        ],
        threshold_pace: 3.7037037, // m/s = 4:30 /km
        pace_units: "MINS_KM",
        pace_zones: null,
        pace_zone_names: null,
      },
      {
        id: 3,
        types: ["Swim", "OpenWaterSwim"],
        ftp: null,
        power_zones: null,
        power_zone_names: null,
        lthr: 172,
        max_hr: 190,
        hr_zones: [145, 153, 162, 171, 176, 181, 190],
        hr_zone_names: null,
        threshold_pace: 0.8333333, // m/s = 2:00 /100 m
        pace_units: "SECS_100M",
        pace_zones: null,
        pace_zone_names: null,
      },
      {
        id: 4,
        types: ["Other"],
        ftp: null,
        power_zones: null,
        lthr: 172,
        max_hr: 190,
        hr_zones: [145, 153, 162, 171, 176, 181, 190],
        threshold_pace: null,
        pace_units: null,
        pace_zones: null,
      },
    ],
  };
}

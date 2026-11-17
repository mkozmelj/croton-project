// One-time TrainingPeaks history import. Local only; keep the export in the
// git-ignored data/ folder.
//   npm run tp:import -- data/trainingpeaks/workouts.csv --from 2024-01-01 --to 2024-12-31 --dry-run
//   npm run tp:import -- data/trainingpeaks/workouts.csv --from 2024-01-01 --to 2024-12-31 \
//     --plan-notes data/literature/trainingpeaks-2024-plan.md
// Completed workouts are upserted into `activities` (safe to repeat, ADR-009). --plan-notes also
// writes the plan as weekly Markdown notes for `npm run ingest -- <file> --type notes`.
// --planned also stores every planned workout as a planned_workouts row, linked to its activity
// (ADR-021); `npm run workouts:classify` then gives them session types.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { env } from "../../config/env.js";
import { createActivityStore } from "../../db/activities.js";
import { createDatabase } from "../../db/client.js";
import { createBackfillStore } from "../../db/planned-workout-backfill.js";
import { addDays, localDate, localMidnight } from "../../utils/dates.js";
import {
  activitiesFromWorkouts,
  isCompleted,
  planMarkdown,
  plannedSessionsFromWorkouts,
  sportFromTrainingPeaks,
  stravaTwin,
  withoutStravaDuplicates,
} from "./mapper.js";
import { parseWorkoutsCsv } from "./workouts.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    to: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "plan-notes": { type: "string" },
    title: { type: "string" },
    planned: { type: "boolean", default: false },
  },
});

const [file] = positionals;
const isDay = (value: string | undefined) =>
  value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value);
if (!file || !isDay(values.from) || !isDay(values.to)) {
  console.error(
    "usage: npm run tp:import -- <workouts.csv> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run] [--plan-notes <out.md>] [--title <notes title>] [--planned]",
  );
  process.exit(1);
}

const { workouts: all, ignoredColumns } = parseWorkoutsCsv(await readFile(file, "utf8"));
const workouts = all.filter(
  (w) => (!values.from || w.day >= values.from) && (!values.to || w.day <= values.to),
);
const completed = workouts.filter(isCompleted);
const rows = activitiesFromWorkouts(workouts, env.TIMEZONE);

const bySport = new Map<string, { count: number; hours: number }>();
for (const w of completed) {
  const sport = sportFromTrainingPeaks(w.type, w.title);
  const entry = bySport.get(sport) ?? { count: 0, hours: 0 };
  bySport.set(sport, { count: entry.count + 1, hours: entry.hours + (w.hours ?? 0) });
}
const days = workouts.map((w) => w.day).sort();
console.log(
  `${workouts.length} workouts ${days[0] ?? "-"} to ${days.at(-1) ?? "-"}: ${completed.length} completed, ${workouts.length - completed.length} planned-only or rest days.`,
);
for (const [sport, { count, hours }] of [...bySport].sort()) {
  console.log(`  ${sport.padEnd(12)} ${String(count).padStart(4)} sessions  ${hours.toFixed(1)} h`);
}
if (ignoredColumns.length > 0) console.log(`Columns not imported: ${ignoredColumns.join(", ")}`);
const withHr = completed.filter((w) => w.avgHr !== null).length;
const withTss = completed.filter((w) => w.tss !== null).length;
console.log(`Completed with avg HR: ${withHr}, with TSS: ${withTss}.`);

if (values["plan-notes"]) {
  const title =
    values.title ?? `TrainingPeaks training log ${days[0] ?? ""} to ${days.at(-1) ?? ""}`;
  await writeFile(values["plan-notes"], planMarkdown(workouts, title));
  console.log(
    `Plan notes written to ${values["plan-notes"]}. Ingest them with:\n  npm run ingest -- ${values["plan-notes"]} --source "${title}" --type notes`,
  );
}

const planned = values.planned ? plannedSessionsFromWorkouts(workouts) : [];
if (values.planned) {
  const linked = planned.filter((s) => s.activityExternalId !== null).length;
  console.log(`${planned.length} planned sessions, ${linked} of them completed.`);
}

if (values["dry-run"]) {
  console.log("Dry run: nothing written to the database.");
  process.exit(0);
}

const db = createDatabase(env.DATABASE_URL);
const store = createActivityStore(db);
const first = days[0];
const last = days.at(-1);
const existing =
  first && last
    ? await store.between(
        localMidnight(first, env.TIMEZONE),
        localMidnight(addDays(last, 1), env.TIMEZONE),
      )
    : [];
const { kept, skipped } = withoutStravaDuplicates(rows, existing, env.TIMEZONE);
for (const row of skipped) {
  console.log(
    `Skipped (already in Strava): ${row.startedAt.toISOString().slice(0, 10)} ${row.sport} ${row.name ?? ""}`,
  );
}
let inserted = 0;
for (const row of kept) {
  if ((await store.upsert(row)).inserted) inserted++;
}
console.log(
  `${kept.length} activities upserted (${inserted} new, ${kept.length - inserted} updated), ${skipped.length} skipped as Strava duplicates.`,
);

if (values.planned) {
  // A completed session links to its imported activity, or to the Strava activity that was
  // kept instead of it.
  const backfill = createBackfillStore(db);
  const byExternalId = await backfill.activitiesByExternalId(
    planned.flatMap((s) => (s.activityExternalId ? [s.activityExternalId] : [])),
  );
  const twins = new Map(
    skipped.flatMap((row) => {
      const twin = stravaTwin(row, existing, env.TIMEZONE);
      return twin ? [[row.externalId, twin] as const] : [];
    }),
  );
  const sessions = planned.map(({ key, workout, activityExternalId }) => {
    const activity = activityExternalId
      ? (byExternalId.get(activityExternalId) ?? twins.get(activityExternalId) ?? null)
      : null;
    return { key, workout, activity };
  });
  const added = await backfill.importSessions(sessions, localDate(new Date(), env.TIMEZONE));
  console.log(`${added} planned sessions stored (${sessions.length - added} were already there).`);
}

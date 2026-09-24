import { schedule } from "node-cron";
import type { Logger } from "pino";

export type Job = {
  name: string;
  // node-cron expression, evaluated in the scheduler's IANA timezone (never a fixed offset).
  cron: string;
  run: () => Promise<void>;
  runOnStart?: boolean;
};

type SchedulerDeps = {
  jobs: readonly Job[];
  timeZone: string;
  logger: Logger;
  // Stack doc §5: a failing cron job also reaches the athlete.
  onFailure: (jobName: string, error: unknown) => Promise<void>;
  onRecovered?: (jobName: string) => Promise<void>;
};

export type Scheduler = { stop(): Promise<void> };

// Wraps a job with the error boundary. Alerts once per failure streak — an hourly job with
// an expired key must not send an alert every hour — and once when it recovers.
export function guardedJob(
  job: Pick<Job, "name" | "run">,
  deps: Pick<SchedulerDeps, "logger" | "onFailure" | "onRecovered">,
): () => Promise<void> {
  const log = deps.logger.child({ module: "scheduler", job: job.name });
  let failing = false;

  return async () => {
    try {
      await job.run();
    } catch (error) {
      log.error({ err: error }, "job failed");
      if (failing) return;
      failing = true;
      await deps.onFailure(job.name, error).catch((alertError: unknown) => {
        log.error({ err: alertError }, "failed to report job failure");
      });
      return;
    }
    if (!failing) return;
    failing = false;
    log.info("job recovered");
    await deps.onRecovered?.(job.name).catch((alertError: unknown) => {
      log.error({ err: alertError }, "failed to report job recovery");
    });
  };
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const tasks = deps.jobs.map((job) => {
    const run = guardedJob(job, deps);
    if (job.runOnStart) void run();
    return schedule(job.cron, run, { name: job.name, timezone: deps.timeZone, noOverlap: true });
  });
  deps.logger.info(
    { module: "scheduler", jobs: deps.jobs.map((job) => `${job.name} (${job.cron})`) },
    "scheduler started",
  );
  return {
    async stop() {
      await Promise.all(tasks.map((task) => task.stop()));
    },
  };
}

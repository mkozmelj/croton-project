import type { Logger } from "pino";

export type BackgroundTasks = {
  // Starts `task` without awaiting it. A failure is logged and handed to `onError`.
  run(label: string, task: () => Promise<void>): void;
  // Resolves once every running task has settled (used on shutdown and in tests).
  drain(): Promise<void>;
};

// Webhooks that must answer fast (Strava: 2 s) hand their real work to this runner. It is
// the error boundary for that work (stack doc §5): structured log + Telegram alert.
export function createBackgroundTasks({
  logger,
  onError,
}: {
  logger: Logger;
  onError: (label: string, error: unknown) => Promise<void>;
}): BackgroundTasks {
  const log = logger.child({ module: "background" });
  const running = new Set<Promise<void>>();

  return {
    run(label, task) {
      const promise = Promise.resolve()
        .then(task)
        .catch(async (error: unknown) => {
          log.error({ err: error, task: label }, "background task failed");
          await onError(label, error).catch((alertError: unknown) => {
            log.error({ err: alertError, task: label }, "failed to report background failure");
          });
        })
        .finally(() => running.delete(promise));
      running.add(promise);
    },

    async drain() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

import type { Logger } from "pino";

// The last error boundary (stack doc §5): an error that no webhook handler, cron guard or
// background runner caught still reaches the athlete, not just the log. An uncaught exception
// leaves the process in an unknown state, so it exits after the alert and Railway restarts
// it. An unhandled rejection is reported and the process goes on.

// Waiting longer than this for the alert would keep a broken process alive.
const ALERT_TIMEOUT_MS = 5_000;
// A leaking loop mustn't send one message per rejection.
const REJECTION_ALERT_INTERVAL_MS = 10 * 60 * 1000;

type GuardDeps = {
  logger: Logger;
  // Never throws (the notifier logs its own failures).
  notify: (text: string) => Promise<void>;
  exit: (code: number) => void;
  now?: () => number;
};

export const withTimeout = (work: Promise<void>, ms = ALERT_TIMEOUT_MS) =>
  Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);

export function processErrorHandlers(deps: GuardDeps) {
  const log = deps.logger.child({ module: "process" });
  const now = deps.now ?? Date.now;
  let lastRejectionAlert = Number.NEGATIVE_INFINITY;

  return {
    async unhandledRejection(reason: unknown) {
      log.error({ err: reason }, "unhandled promise rejection");
      if (now() - lastRejectionAlert < REJECTION_ALERT_INTERVAL_MS) return;
      lastRejectionAlert = now();
      await withTimeout(
        deps.notify("⚠️ Something failed in the background without being handled. It's logged."),
      );
    },

    async uncaughtException(error: unknown) {
      log.fatal({ err: error }, "uncaught exception, exiting");
      await withTimeout(
        deps.notify("⚠️ The app hit an unexpected error and is restarting. It's logged."),
      );
      deps.exit(1);
    },
  };
}

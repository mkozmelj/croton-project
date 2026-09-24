import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { guardedJob } from "./cron.js";

function setup(outcomes: boolean[]) {
  const alerts: string[] = [];
  let call = 0;
  const run = guardedJob(
    {
      name: "test-job",
      run: async () => {
        if (!outcomes[call++]) throw new Error("boom");
      },
    },
    {
      logger: pino({ level: "silent" }),
      onFailure: async (name) => {
        alerts.push(`failed:${name}`);
      },
      onRecovered: async (name) => {
        alerts.push(`recovered:${name}`);
      },
    },
  );
  return { run, alerts };
}

describe("guardedJob", () => {
  it("alerts once per failure streak and once on recovery", async () => {
    const { run, alerts } = setup([true, false, false, false, true, true, false]);
    for (let i = 0; i < 7; i++) await run();
    expect(alerts).toEqual(["failed:test-job", "recovered:test-job", "failed:test-job"]);
  });

  it("never throws, even when the alert itself fails", async () => {
    const run = guardedJob(
      {
        name: "test-job",
        run: async () => {
          throw new Error("boom");
        },
      },
      {
        logger: pino({ level: "silent" }),
        onFailure: async () => {
          throw new Error("telegram down");
        },
      },
    );
    await expect(run()).resolves.toBeUndefined();
  });
});

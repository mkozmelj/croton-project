import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createBackgroundTasks } from "./background.js";

describe("createBackgroundTasks", () => {
  it("runs tasks after returning and reports failures to onError", async () => {
    const failures: string[] = [];
    const tasks = createBackgroundTasks({
      logger: pino({ level: "silent" }),
      onError: async (label) => {
        failures.push(label);
      },
    });
    const done: string[] = [];

    tasks.run("ok", async () => {
      done.push("ok");
    });
    tasks.run("broken", async () => {
      throw new Error("boom");
    });
    expect(done).toEqual([]); // nothing ran synchronously

    await tasks.drain();
    expect(done).toEqual(["ok"]);
    expect(failures).toEqual(["broken"]);
  });

  it("survives a failing onError", async () => {
    const tasks = createBackgroundTasks({
      logger: pino({ level: "silent" }),
      onError: async () => {
        throw new Error("telegram down");
      },
    });
    tasks.run("broken", async () => {
      throw new Error("boom");
    });
    await expect(tasks.drain()).resolves.toBeUndefined();
  });
});

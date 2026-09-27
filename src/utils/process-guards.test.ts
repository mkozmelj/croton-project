import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { processErrorHandlers } from "./process-guards.js";

function setup() {
  const sent: string[] = [];
  const exits: number[] = [];
  let clock = 0;
  const handlers = processErrorHandlers({
    logger: pino({ level: "silent" }),
    notify: async (text) => {
      sent.push(text);
    },
    exit: (code) => exits.push(code),
    now: () => clock,
  });
  return {
    handlers,
    sent,
    exits,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("processErrorHandlers", () => {
  it("alerts on an uncaught exception, then exits", async () => {
    const { handlers, sent, exits } = setup();
    await handlers.uncaughtException(new Error("boom"));
    expect(sent).toHaveLength(1);
    expect(exits).toEqual([1]);
  });

  it("alerts on unhandled rejections at most every 10 minutes, without exiting", async () => {
    const { handlers, sent, exits, advance } = setup();
    await handlers.unhandledRejection(new Error("a"));
    await handlers.unhandledRejection(new Error("b"));
    advance(10 * 60 * 1000);
    await handlers.unhandledRejection(new Error("c"));
    expect(sent).toHaveLength(2);
    expect(exits).toEqual([]);
  });

  it("still exits when the alert hangs", async () => {
    const exits: number[] = [];
    const handlers = processErrorHandlers({
      logger: pino({ level: "silent" }),
      notify: () => new Promise(() => {}),
      exit: (code) => exits.push(code),
    });
    vi.useFakeTimers();
    const done = handlers.uncaughtException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    vi.useRealTimers();
    expect(exits).toEqual([1]);
  });
});

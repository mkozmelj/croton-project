import type { Update } from "grammy/types";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { inMemoryPending } from "../agent/test-helpers.js";
import { type CommandDeps, registerCommands } from "./commands.js";
import { errorBoundary } from "./handlers.js";
import { offlineBot } from "./test-helpers.js";

const CHAT = 1001;

function command(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 3,
      date: 0,
      chat: { id: CHAT, type: "private", first_name: "Athlete" },
      from: { id: CHAT, is_bot: false, first_name: "Athlete" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
    },
  };
}

// Only the deps these commands use; the rest would fail loudly if touched.
function setup() {
  const { bot, calls } = offlineBot();
  const pending = inMemoryPending();
  let selfTests = 0;
  bot.use(errorBoundary(pino({ level: "silent" })));
  registerCommands(bot, {
    pending: pending.store,
    runSelfTest: () => {
      selfTests++;
    },
    timeZone: "Europe/Ljubljana",
    now: () => new Date("2026-09-27T10:00:00Z"),
  } as unknown as CommandDeps);
  const sent = () =>
    calls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload as { text: string; reply_markup?: unknown });
  return { bot, sent, pending, selfTests: () => selfTests };
}

describe("/selftest", () => {
  it("starts a failing background task and fails through the error boundary", async () => {
    const { bot, sent, selfTests } = setup();
    await bot.handleUpdate(command("/selftest"));
    expect(selfTests()).toBe(1);
    expect(sent().map((m) => m.text)).toEqual([
      expect.stringMatching(/^Self-test/),
      expect.stringMatching(/^⚠️ Something broke/),
    ]);
  });
});

describe("/profile editing", () => {
  it("proposes the change with Confirm/Cancel buttons", async () => {
    const { bot, sent, pending } = setup();
    await bot.handleUpdate(command("/profile ftp 262"));
    expect(pending.rows()).toMatchObject([
      {
        chatId: CHAT,
        actionType: "add_fitness_marker",
        payload: { markers: [{ metric: "ftp_w", value: 262, measuredOn: "2026-09-27" }] },
      },
    ]);
    expect(sent()[0]?.text).toContain("FTP 262 W");
    expect(sent()[0]?.reply_markup).toBeDefined();
  });

  it("explains the syntax when the edit doesn't parse, and proposes nothing", async () => {
    const { bot, sent, pending } = setup();
    await bot.handleUpdate(command("/profile lthr 168"));
    expect(pending.rows()).toEqual([]);
    expect(sent()[0]?.text).toMatch(/^Say which sport[\s\S]*\/profile ftp 250/);
  });
});

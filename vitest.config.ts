import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // src/config/env.ts validates process.env at import time. Obviously fake values only.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      TELEGRAM_BOT_TOKEN: "test-bot-token",
      TELEGRAM_AUTHORIZED_CHAT_ID: "1000",
      ANTHROPIC_API_KEY: "test-anthropic-key",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});

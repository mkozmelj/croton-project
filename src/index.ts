import { env } from "./config/env.js";
import { buildServer } from "./server.js";

const app = buildServer({ logLevel: env.LOG_LEVEL });

// Railway sends SIGTERM on every redeploy — let in-flight requests finish first.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error, "error during shutdown");
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.fatal(error, "server failed to start");
  process.exit(1);
}

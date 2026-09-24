import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

type ServerOptions = {
  logger: FastifyBaseLogger;
  // Stack doc §5: a request that fails with a 5xx also reaches the athlete, not just the log.
  onServerError?: (route: string, error: unknown) => Promise<void>;
};

export function buildServer({ logger, onServerError }: ServerOptions): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  // Set before any route or plugin is registered, so every scope inherits it.
  app.setErrorHandler(async (error, request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    if (status < 500) return reply.send(error);

    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown";
    request.log.error({ err: error, route }, "request failed");
    await onServerError?.(route, error).catch((alertError: unknown) => {
      request.log.error({ err: alertError }, "failed to report request failure");
    });
    // Empty body: no internals leak to the caller.
    return reply.code(500).send();
  });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

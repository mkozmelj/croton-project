import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

type ServerOptions = {
  logger: FastifyBaseLogger;
};

export function buildServer({ logger }: ServerOptions): FastifyInstance {
  const app = Fastify({ loggerInstance: logger });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

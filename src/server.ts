import Fastify, { type FastifyInstance } from "fastify";

type ServerOptions = {
  logLevel: string;
};

export function buildServer({ logLevel }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: { level: logLevel } });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

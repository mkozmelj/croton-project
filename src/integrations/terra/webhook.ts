import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { HealthMetricsStore } from "../../db/health-metrics.js";
import { secureEquals } from "../../utils/secure-compare.js";
import { parseTerraPayload, type TerraPayload } from "./parser.js";

export const TERRA_WEBHOOK_PATH = "/webhook/terra";

const SIGNATURE_HEADER = "terra-signature";
// Sleep payloads with samples can run to a few MB.
const BODY_LIMIT_BYTES = 20 * 1024 * 1024;

// `terra-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=...]`.
// No timestamp tolerance: Terra retries for ~8 h with the original signature, and every
// write is an idempotent upsert, so a replay changes nothing.
export function verifyTerraSignature(header: unknown, rawBody: Buffer, secret: string): boolean {
  if (typeof header !== "string") return false;
  const pairs = header.split(",").map((part) => part.trim().split("="));
  const timestamp = pairs.find(([key]) => key === "t")?.[1];
  const signatures = pairs.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  // Check every candidate (no early exit), per Terra's multi-signature format.
  return signatures.map((signature) => secureEquals(signature, expected)).includes(true);
}

type TerraWebhookDeps = {
  signingSecret: string;
  timeZone: string;
  health: Pick<HealthMetricsStore, "upsert">;
  onAuthEvent: (event: Extract<TerraPayload, { kind: "auth" }>) => Promise<void>;
  // A signed payload that doesn't parse is a bug on our side: alert and acknowledge, since
  // Terra resending it can't help. Other failures (e.g. the DB) throw → 500 → Terra retries,
  // and the server's error handler sends the alert.
  onUnparseable: (error: unknown) => Promise<void>;
};

// ADR-012: the HMAC is checked on the raw bytes before any JSON parsing. The route lives in
// its own plugin scope so the raw-Buffer body parser doesn't affect other routes.
export function registerTerraWebhook(app: FastifyInstance, deps: TerraWebhookDeps): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });

    scope.post(TERRA_WEBHOOK_PATH, { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const log = request.log.child({ module: "terra-webhook" });
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (!verifyTerraSignature(request.headers[SIGNATURE_HEADER], raw, deps.signingSecret)) {
        log.warn("rejected webhook with bad signature");
        return reply.code(401).send();
      }

      let payload: TerraPayload;
      try {
        payload = parseTerraPayload(JSON.parse(raw.toString("utf8")), deps.timeZone);
      } catch (error) {
        log.error({ err: error }, "unparseable Terra payload");
        await deps.onUnparseable(error);
        return reply.code(200).send();
      }

      if (payload.kind === "auth") {
        log.info({ type: payload.type, status: payload.status }, "terra auth event");
        await deps.onAuthEvent(payload);
      } else if (payload.kind === "metrics") {
        // A failure here → 500 → Terra retries; the upserts make that safe (ADR-009).
        for (const update of payload.updates) await deps.health.upsert(update);
        log.info({ days: payload.updates.map((update) => update.date) }, "health metrics stored");
      } else {
        log.debug({ type: payload.type }, "ignored Terra payload type");
      }
      return reply.code(200).send();
    });
  });
}

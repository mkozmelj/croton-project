import { z } from "zod";

// ADR-001: the only place model IDs are written down. Bump here + re-check pricing.ts.
export const MODELS = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

// ADR-014: OpenAI embeddings for the literature corpus. Every literature_chunks row records the
// model it was embedded with; changing this means re-running ingest on the source files.
export const EMBEDDING_MODEL = "text-embedding-3-small";

// z.coerce.boolean() turns the string "false" into true — parse the literal instead.
const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalSecret = z.string().min(1).optional();

// ADR-011: AES-256-GCM needs exactly 32 key bytes (`openssl rand -base64 32`).
const encryptionKey = z
  .base64()
  .refine((value) => Buffer.from(value, "base64").length === 32, "must decode to 32 bytes")
  .optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    APP_URL: z.url().optional(),
    TIMEZONE: z.string().min(1).default("Europe/Ljubljana"),
    MONTHLY_LLM_BUDGET_EUR: z.coerce.number().positive().default(14),

    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/, "must be 16-256 chars of A-Z, a-z, 0-9, _ or -")
      .optional(),
    TELEGRAM_AUTHORIZED_CHAT_ID: z.coerce.number().int(),

    ANTHROPIC_API_KEY: z.string().min(1),
    DISABLE_THINKING: booleanString,

    DATABASE_URL: z.string().min(1),

    // Phase 2+ integrations. Optional until the phase that uses them makes them required.
    STRAVA_CLIENT_ID: optionalSecret,
    STRAVA_CLIENT_SECRET: optionalSecret,
    STRAVA_WEBHOOK_VERIFY_TOKEN: optionalSecret,
    // Printed by `npm run strava:subscribe`. Not a secret; events for any other id are rejected.
    STRAVA_SUBSCRIPTION_ID: z.coerce.number().int().positive().optional(),
    GOOGLE_CLIENT_ID: optionalSecret,
    GOOGLE_CLIENT_SECRET: optionalSecret,
    TOKEN_ENCRYPTION_KEY: encryptionKey,
    // ADR-015: health data from Intervals.icu (Settings → Developer Settings).
    INTERVALS_API_KEY: optionalSecret,
    INTERVALS_ATHLETE_ID: z
      .string()
      .regex(/^i?\d+$/, "the athlete id from Intervals.icu settings, e.g. i12345")
      .optional(),
    OPENAI_API_KEY: optionalSecret,
  })
  .superRefine((value, ctx) => {
    // Production runs the Telegram webhook (ADR-012), which needs a public URL and a secret.
    if (value.NODE_ENV !== "production") return;
    if (!value.APP_URL) {
      ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "required in production" });
    }
    if (!value.TELEGRAM_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["TELEGRAM_WEBHOOK_SECRET"],
        message: "required in production",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  // .env.example documents empty values as `KEY=`; treat those as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  return envSchema.parse(cleaned);
}

export const env = parseEnv(process.env);

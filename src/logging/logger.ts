import { type Logger, pino, stdSerializers } from "pino";

// ADR-013 / stack doc §5: secrets are redacted at the logger, not at every call site.
export const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'req.headers["x-telegram-bot-api-secret-token"]',
  "*.access_token",
  "*.refresh_token",
  "*.authorization_token",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.secret",
  "*.password",
];

const REDACTED = "[Redacted]";

type LoggerOptions = {
  level: string;
  // Raw secret values to scrub from serialized errors (e.g. a bot token inside a URL).
  secrets: readonly string[];
};

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.replaceAll(secret, REDACTED);
  }
  return result;
}

// A connection string's password can show up on its own in driver errors, so scrub it
// separately from the full URL.
export function connectionStringSecrets(connectionString: string): string[] {
  const secrets = [connectionString];
  try {
    const { password } = new URL(connectionString);
    if (password) secrets.push(password, decodeURIComponent(password));
  } catch {
    // Not URL-shaped; the full string is still scrubbed.
  }
  return secrets;
}

// Scrubs the whole serialized error — message, stack, `cause` chain and any extra
// properties an SDK attaches — not just the top-level message.
export function serializeError(error: Error, secrets: readonly string[]): unknown {
  const serialized = stdSerializers.err(error);
  try {
    const scrubbed: unknown = JSON.parse(scrubSecrets(JSON.stringify(serialized), secrets));
    return scrubbed;
  } catch {
    // Unserializable (e.g. circular) extra properties: keep only the scrubbed basics.
    return {
      type: serialized.type,
      message: scrubSecrets(serialized.message, secrets),
      stack: scrubSecrets(serialized.stack ?? "", secrets),
    };
  }
}

export function createLogger({ level, secrets }: LoggerOptions): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      err: (error: Error) => serializeError(error, secrets),
    },
  });
}

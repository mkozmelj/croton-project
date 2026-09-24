// Outbound HTTP calls to third-party APIs always carry a timeout: a request that hangs
// would otherwise block a no-overlap cron job forever and stall shutdown's task drain.
export const HTTP_TIMEOUT_MS = 20_000;

export const timeoutSignal = () => AbortSignal.timeout(HTTP_TIMEOUT_MS);

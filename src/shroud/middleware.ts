export interface ShroudResponseInfo {
  redactedCount: number | null;
  injectionScore: number | null;
}

export type LogFn = (level: string, message: string, data: Record<string, unknown>) => void;

const defaultLog: LogFn = (level, message, data) => {
  const payload = JSON.stringify({ level, message, ...data });
  if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
};

/**
 * Parses Shroud response headers and writes a structured log line.
 * Accepts a custom logger callback so callers can route to their own sink.
 */
export function logShroudResponse(
  headers: Headers,
  log: LogFn = defaultLog,
): ShroudResponseInfo {
  const rawRedacted = headers.get("x-shroud-redacted-count");
  const rawInjection = headers.get("x-shroud-injection-score");

  const redactedCount = rawRedacted !== null ? parseInt(rawRedacted, 10) : null;
  const injectionScore = rawInjection !== null ? parseFloat(rawInjection) : null;

  const data: Record<string, unknown> = {};
  if (redactedCount !== null) data.redactedCount = redactedCount;
  if (injectionScore !== null) data.injectionScore = injectionScore;

  if (injectionScore !== null && injectionScore > 0.7) {
    log("warn", "High injection score detected by Shroud", data);
  } else if (Object.keys(data).length > 0) {
    log("info", "Shroud inspection completed", data);
  }

  return { redactedCount, injectionScore };
}

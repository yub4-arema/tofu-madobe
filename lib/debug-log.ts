export type DebugDetails = Record<string, unknown>;

export type LogEntry = {
  time: string;
  level: "info" | "warn" | "error";
  scope: string;
  event: string;
  details?: DebugDetails;
};

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "password",
  "token",
  "secret",
]);

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (typeof value === "string") {
    if (value.startsWith("Bearer ")) return "Bearer [REDACTED]";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        result[k] = "[REDACTED]";
      } else {
        result[k] = sanitize(v, depth + 1);
      }
    }
    return result;
  }
  return value;
}

const clientBuffer: LogEntry[] = [];
let clientFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushClientBuffer() {
  if (clientBuffer.length === 0 || typeof window === "undefined") return;
  const batch = clientBuffer.splice(0, clientBuffer.length);
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
    });
  } catch {
    // Ignore fetch errors during log flush
  }
}

function scheduleClientFlush() {
  if (typeof window === "undefined") return;
  if (clientBuffer.length >= 20) {
    if (clientFlushTimer) clearTimeout(clientFlushTimer);
    clientFlushTimer = null;
    void flushClientBuffer();
    return;
  }
  if (!clientFlushTimer) {
    clientFlushTimer = setTimeout(() => {
      clientFlushTimer = null;
      void flushClientBuffer();
    }, 1000);
  }
}

export async function startDebugLogSession(mode: "natural" | "default") {
  if (typeof window === "undefined") return null;
  if (clientFlushTimer) clearTimeout(clientFlushTimer);
  clientFlushTimer = null;
  await flushClientBuffer();
  const response = await fetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: mode }),
  });
  if (!response.ok) throw new Error(`ログセッションの開始に失敗しました: ${response.status}`);
  const result = (await response.json()) as { fileName?: unknown };
  return typeof result.fileName === "string" ? result.fileName : null;
}

function recordLog(entry: LogEntry) {
  if (typeof window !== "undefined") {
    clientBuffer.push(entry);
    scheduleClientFlush();
  } else {
    void import("./server/session-logger.ts")
      .then(({ appendLogEntries }) => appendLogEntries([entry]))
      .catch(() => {
        void import("./server/session-logger")
          .then(({ appendLogEntries }) => appendLogEntries([entry]))
          .catch(() => {});
      });
  }
}

function serialize(details: DebugDetails) {
  try {
    return JSON.stringify(details);
  } catch {
    return details;
  }
}

export function debugLog(scope: string, event: string, details?: DebugDetails) {
  const time = new Date().toISOString();
  const sanitized = details ? (sanitize(details) as DebugDetails) : undefined;
  const prefix = `${time} [${scope}] ${event}`;
  if (sanitized) console.log(prefix, serialize(sanitized));
  else console.log(prefix);
  recordLog({ time, level: "info", scope, event, details: sanitized });
}

export function debugWarn(scope: string, event: string, details?: DebugDetails) {
  const time = new Date().toISOString();
  const sanitized = details ? (sanitize(details) as DebugDetails) : undefined;
  const prefix = `${time} [${scope}] ${event}`;
  if (sanitized) console.warn(prefix, serialize(sanitized));
  else console.warn(prefix);
  recordLog({ time, level: "warn", scope, event, details: sanitized });
}

export function debugError(
  scope: string,
  event: string,
  error: unknown,
  details: DebugDetails = {},
) {
  const time = new Date().toISOString();
  const sanitized = sanitize({
    ...details,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
  }) as DebugDetails;
  console.error(`${time} [${scope}] ${event}`, serialize(sanitized));
  recordLog({ time, level: "error", scope, event, details: sanitized });
}

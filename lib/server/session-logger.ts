import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type LogEntry = {
  time: string;
  level: "info" | "warn" | "error";
  scope: string;
  event: string;
  details?: Record<string, unknown>;
};

const logDirectory = path.join(process.cwd(), ".data", "logs");
const defaultLogFile = path.join(logDirectory, "session.ndjson");
let activeLogFile = defaultLogFile;
let writeTail = Promise.resolve();

export function startLogSession(mode: "natural" | "default") {
  const fileName =
    mode === "natural"
      ? `natural-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.ndjson`
      : "session.ndjson";
  const nextLogFile = path.join(logDirectory, fileName);
  const rotation = writeTail.then(async () => {
    await mkdir(logDirectory, { recursive: true });
    await appendFile(nextLogFile, "", "utf8");
    activeLogFile = nextLogFile;
  });
  writeTail = rotation.catch((error: unknown) => {
    console.error("session-logger: session switch failed", error);
  });
  return rotation.then(() => fileName);
}

export function appendLogEntries(entries: LogEntry[]) {
  if (!entries.length) return;
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeTail = writeTail
    .then(async () => {
      await mkdir(logDirectory, { recursive: true });
      await appendFile(activeLogFile, lines, "utf8");
    })
    .catch((error: unknown) => {
      console.error("session-logger: file append failed", error);
    });
}

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LogEntry = {
  time: string;
  level: "info" | "warn" | "error";
  scope: string;
  event: string;
  details?: Record<string, unknown>;
};

const logDirectory = path.join(process.cwd(), ".data", "logs");
const logFile = path.join(logDirectory, "session.ndjson");
let writeTail = Promise.resolve();

export function appendLogEntries(entries: LogEntry[]) {
  if (!entries.length) return;
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeTail = writeTail
    .then(async () => {
      await mkdir(logDirectory, { recursive: true });
      await appendFile(logFile, lines, "utf8");
    })
    .catch((error: unknown) => {
      console.error("session-logger: file append failed", error);
    });
}

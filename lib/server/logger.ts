import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

type Details = Record<string, unknown>

const logDirectory = path.join(process.cwd(), ".data", "logs")
const logFile = path.join(logDirectory, "server.ndjson")
let writeTail = Promise.resolve()

function write(level: "info" | "error", event: string, details: Details) {
  const entry = {
    at: new Date().toISOString(),
    level,
    scope: "tofu-madobe",
    event,
    ...details,
  }
  const line = JSON.stringify(entry)
  if (level === "error") console.error(line)
  else console.info(line)

  writeTail = writeTail
    .then(async () => {
      await mkdir(logDirectory, { recursive: true })
      await appendFile(logFile, `${line}\n`, "utf8")
    })
    .catch((error: unknown) => console.error("tofu-madobe log write failed", error))
}

export function serverLog(event: string, details: Details = {}) {
  write("info", event, details)
}

export function serverError(event: string, error: unknown, details: Details = {}) {
  write("error", event, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  })
}

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const target = process.argv[2]
const voicevoxModes = {
  local: "local",
  api: "su-shiki",
}
const voicevoxMode = voicevoxModes[target]

if (!voicevoxMode) {
  throw new Error("使い方: node scripts/start.mjs <local|api> [Next.jsのオプション]")
}

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url))
const child = spawn(process.execPath, [nextCli, "start", ...process.argv.slice(3)], {
  stdio: "inherit",
  env: { ...process.env, VOICEVOX_MODE: voicevoxMode },
})

child.on("error", (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on("exit", (code) => {
  process.exitCode = code ?? 1
})

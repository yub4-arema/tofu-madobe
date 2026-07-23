import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const audioDir = join(tmpdir(), "tofu-madobe-audio");
const maxAgeMs = 30 * 60 * 1000;

function filePath(id: string) {
  return join(audioDir, `${id}.wav`);
}

function cleanup() {
  if (!existsSync(audioDir)) return;
  const expiresBefore = Date.now() - maxAgeMs;
  for (const name of readdirSync(audioDir)) {
    const path = join(audioDir, name);
    if (statSync(path).mtimeMs < expiresBefore) rmSync(path, { force: true });
  }
}

export const audioStore = {
  set(id: string, bytes: Uint8Array) {
    mkdirSync(audioDir, { recursive: true });
    cleanup();
    writeFileSync(filePath(id), bytes);
  },
  get(id: string) {
    cleanup();
    const path = filePath(id);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  },
};

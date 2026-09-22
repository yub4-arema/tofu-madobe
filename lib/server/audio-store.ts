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
import { debugError, debugLog } from "../debug-log";

const audioDir = join(tmpdir(), "tofu-madobe-audio");
const maxAgeMs = 30 * 60 * 1000;

function filePath(id: string) {
  return join(audioDir, `${id}.wav`);
}

function cleanup() {
  if (!existsSync(audioDir)) {
    debugLog("audio-store", "cleanup skipped: directory does not exist", { audioDir });
    return;
  }
  const expiresBefore = Date.now() - maxAgeMs;
  for (const name of readdirSync(audioDir)) {
    const path = join(audioDir, name);
    if (statSync(path).mtimeMs < expiresBefore) {
      rmSync(path, { force: true });
      debugLog("audio-store", "expired audio removed", { name, path });
    }
  }
}

export const audioStore = {
  set(id: string, bytes: Uint8Array) {
    const path = filePath(id);
    try {
      mkdirSync(audioDir, { recursive: true });
      cleanup();
      writeFileSync(path, bytes);
      debugLog("audio-store", "audio stored", { id, path, bytes: bytes.byteLength });
    } catch (error) {
      debugError("audio-store", "audio store failed", error, { id, path, bytes: bytes.byteLength });
      throw error;
    }
  },
  get(id: string) {
    const path = filePath(id);
    try {
      cleanup();
      if (!existsSync(path)) {
        debugLog("audio-store", "audio cache miss", { id, path });
        return undefined;
      }
      const bytes = new Uint8Array(readFileSync(path));
      debugLog("audio-store", "audio cache hit", { id, path, bytes: bytes.byteLength });
      return bytes;
    } catch (error) {
      debugError("audio-store", "audio read failed", error, { id, path });
      throw error;
    }
  },
};

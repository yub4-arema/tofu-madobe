import { AppError } from "./errors"
import { serverError, serverLog } from "./logger"

export type VoicevoxService = { synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> }

async function localSynthesize(text: string, signal?: AbortSignal) {
  const baseUrl = (process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021").replace(/\/+$/, "")
  const speaker = Number(process.env.VOICEVOX_SPEAKER_ID ?? "1")
  const startedAt = Date.now()
  serverLog("tts.synthesis.started", { provider: "local", speaker, text, characters: text.length })
  try {
    const queryResponse = await fetch(
      `${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: "POST", signal }
    )
    if (!queryResponse.ok) throw new AppError("VOICEVOX_AUDIO_QUERY_FAILED", await queryResponse.text(), 502)
    const query = (await queryResponse.json()) as { postPhonemeLength?: number }
    query.postPhonemeLength = Math.max(query.postPhonemeLength ?? 0, 0.35)
    const synthesis = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal,
    })
    if (!synthesis.ok) throw new AppError("VOICEVOX_SYNTHESIS_FAILED", await synthesis.text(), 502)
    const audio = new Uint8Array(await synthesis.arrayBuffer())
    serverLog("tts.synthesis.completed", {
      provider: "local",
      speaker,
      characters: text.length,
      bytes: audio.byteLength,
      durationMs: Date.now() - startedAt,
    })
    return audio
  } catch (error) {
    if (error instanceof AppError || (error instanceof DOMException && error.name === "AbortError")) throw error
    serverError("tts.synthesis.failed", error, { provider: "local", speaker, characters: text.length })
    throw new AppError("VOICEVOX_UNAVAILABLE", `VOICEVOXへ接続できません: ${baseUrl}`, 503)
  }
}

async function apiSynthesize(text: string, signal?: AbortSignal) {
  const key = process.env.SU_SHIKI_API_KEY
  if (!key) throw new AppError("VOICEVOX_API_KEY_MISSING", "SU_SHIKI_API_KEYが必要です。")
  const speaker = Number(process.env.VOICEVOX_SPEAKER_ID ?? "1")
  const startedAt = Date.now()
  serverLog("tts.synthesis.started", { provider: "su-shiki", speaker, text, characters: text.length })
  const url = new URL("https://deprecatedapis.tts.quest/v2/voicevox/audio/")
  url.searchParams.set("speaker", String(speaker))
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ text, key }),
    signal,
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!response.ok || new TextDecoder().decode(bytes.slice(0, 12)).slice(0, 4) !== "RIFF") {
    serverLog("tts.synthesis.failed", { provider: "su-shiki", speaker, status: response.status, characters: text.length })
    throw new AppError("VOICEVOX_API_FAILED", `WEB版VOICEVOX APIが失敗しました (${response.status})。`, 502)
  }
  serverLog("tts.synthesis.completed", {
    provider: "su-shiki",
    speaker,
    characters: text.length,
    bytes: bytes.byteLength,
    durationMs: Date.now() - startedAt,
  })
  return bytes
}

export const voicevox: VoicevoxService = {
  synthesize(text, signal) {
    return process.env.VOICEVOX_MODE === "su-shiki" ? apiSynthesize(text, signal) : localSynthesize(text, signal)
  },
}

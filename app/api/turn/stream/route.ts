import { Buffer } from "node:buffer"
import { enqueueSpeech } from "@/lib/server/speech-queue"
import { errorDetails } from "@/lib/server/errors"
import type { ChatMessage } from "@/lib/server/llm"
import { writeTurn } from "@/lib/server/turn"
import { serverError, serverLog } from "@/lib/server/logger"
import type { MotionHotkeyChoice, TurnEvent } from "@/lib/protocol"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
const maxCurrentAudioBytes = 8 * 1024 * 1024

function isWav(bytes: Uint8Array) {
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WAVE"
}

function parseHotkeys(value: FormDataEntryValue | null): MotionHotkeyChoice[] {
  if (typeof value !== "string" || !value) return []
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const tag = (item as { tag?: unknown }).tag
    const name = (item as { name?: unknown }).name
    return typeof tag === "string" && tag.length > 0 && tag.length <= 64 && !tag.includes("[") && !tag.includes("]") && !/\s/u.test(tag) && typeof name === "string"
      ? [{ tag: tag.toLocaleLowerCase(), name: name.slice(0, 100) }]
      : []
  }).slice(0, 50)
}

function parseHistory(value: FormDataEntryValue | null): ChatMessage[] {
  if (typeof value !== "string" || !value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): ChatMessage[] => {
      if (!item || typeof item !== "object") return []
      const role = (item as { role?: unknown }).role
      const content = (item as { content?: unknown }).content
      return role === "assistant" && typeof content === "string" && content.trim()
        ? [{ role, content: content.slice(0, 4000) }]
        : []
    }).slice(-16)
  } catch {
    return []
  }
}

export async function POST(request: Request) {
  const form = await request.formData()
  const file = form.get("audio")
  let audio: Uint8Array | undefined
  if (file instanceof File && file.size > 0) {
    if (file.size > maxCurrentAudioBytes) {
      return Response.json({ error: { code: "AUDIO_TOO_LARGE", message: "録音は8 MiB以下にしてください。" } }, { status: 413 })
    }
    audio = new Uint8Array(await file.arrayBuffer())
    if (!isWav(audio)) {
      return Response.json({ error: { code: "INVALID_AUDIO", message: "16-bit PCM WAVを送信してください。" } }, { status: 400 })
    }
  }
  const soloPrompt =
    typeof form.get("soloPrompt") === "string" && String(form.get("soloPrompt")).trim()
      ? String(form.get("soloPrompt")).trim()
      : "直近と重複しない短い話題を一つ自然に話してください。待機や自動発言には触れないでください。"
  if (!audio && form.get("mode") !== "scheduled") {
    return Response.json({ error: { code: "AUDIO_EMPTY", message: "送信できる録音がまだありません。" } }, { status: 400 })
  }

  serverLog("turn.received", {
    mode: typeof form.get("mode") === "string" ? form.get("mode") : "unknown",
    audioBytes: audio?.byteLength ?? 0,
    hasAudio: Boolean(audio),
  })

  const system = typeof form.get("system") === "string" ? String(form.get("system")) : undefined
  const motionHotkeys = parseHotkeys(form.get("motionHotkeys"))
  const history = parseHistory(form.get("history"))
  const messages: ChatMessage[] = audio
    ? [
        ...history,
        {
          role: "user",
          content: [
            { type: "text", text: "録音されたユーザーの発話を聞き、会話履歴を踏まえて自然に返答してください。" },
            { type: "input_audio", input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" } },
          ],
        },
      ]
    : [...history, { role: "user", content: soloPrompt }]
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: TurnEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      void enqueueSpeech(async () => {
        try {
          const text = await writeTurn({
            messages,
            system,
            motionHotkeys,
            signal: request.signal,
            write,
          })
          serverLog("turn.output.persisted", { characters: text.length, historyMessages: history.length + 1 })
        } catch (error) {
          const detail = errorDetails(error)
          serverError("turn.failed", error, { code: detail.code })
          write({ type: "turn.error", turnId: crypto.randomUUID(), error: { code: detail.code, message: detail.message } })
        } finally {
          controller.close()
        }
      })
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

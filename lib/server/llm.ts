import { Buffer } from "node:buffer"
import { AppError } from "./errors"

export type InputAudioPart = {
  type: "input_audio"
  input_audio: { data: string; format: "wav" }
}
export type TextPart = { type: "text"; text: string }
export type ChatMessage = {
  role: "system" | "user" | "assistant"
  content: string | Array<TextPart | InputAudioPart>
}

type Chunk = { choices?: Array<{ delta?: { content?: string | null } }> }

function endpoint() {
  const base = process.env.OPENAI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai"
  return `${base.replace(/\/+$/, "")}/chat/completions`
}

function headers() {
  const result = new Headers({ "Content-Type": "application/json" })
  const username = process.env.OPENAI_BASIC_AUTH_USERNAME
  const password = process.env.OPENAI_BASIC_AUTH_PASSWORD
  if (username || password) {
    if (!username || !password) throw new AppError("LLM_BASIC_AUTH_INCOMPLETE", "Basic認証のユーザー名とパスワードは両方必要です。")
    result.set("Authorization", `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`)
  } else if (process.env.OPENAI_API_KEY) {
    result.set("Authorization", `Bearer ${process.env.OPENAI_API_KEY}`)
  }
  return result
}

function streamText(line: string) {
  if (!line.startsWith("data:")) return null
  const data = line.slice(5).trim()
  if (!data || data === "[DONE]") return null
  return (JSON.parse(data) as Chunk).choices?.[0]?.delta?.content ?? null
}

export async function* generateReply(messages: ChatMessage[], signal?: AbortSignal) {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? "gemini-3.5-flash", messages, stream: true }),
    signal,
  }).catch((error: unknown) => {
    throw new AppError("LLM_UNAVAILABLE", error instanceof Error ? error.message : "LLMへ接続できません。", 503)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new AppError("LLM_REQUEST_FAILED", detail || `${response.status} ${response.statusText}`, 502)
  }
  if (!response.body) throw new AppError("LLM_STREAM_MISSING", "LLMのストリームがありません。", 502)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let received = false
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const text = streamText(line)
      if (text) {
        received = true
        yield text
      }
    }
    if (done) break
  }
  const last = streamText(buffer)
  if (last) {
    received = true
    yield last
  }
  if (!received) throw new AppError("LLM_EMPTY_RESPONSE", "LLMの返答が空でした。", 502)
}

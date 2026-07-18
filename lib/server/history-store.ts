import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ChatMessage } from "./llm"

type StoredMessage =
  | { role: "user"; kind: "audio"; audioId: string }
  | { role: "user"; kind: "text"; text: string }
  | { role: "assistant"; kind: "text"; text: string }

type PendingTurn = { messages: StoredMessage[]; audioId?: string }
const dataDir = join(process.cwd(), ".data")
const inputDir = join(dataDir, "input-audio")
const historyPath = join(dataDir, "history.json")
const maxMessages = 32
const maxAudioBytes = 10 * 1024 * 1024

async function load(): Promise<StoredMessage[]> {
  try {
    return JSON.parse(await readFile(historyPath, "utf8")) as StoredMessage[]
  } catch {
    return []
  }
}

async function save(messages: StoredMessage[]) {
  await mkdir(dataDir, { recursive: true })
  const temporary = `${historyPath}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(messages, null, 2), "utf8")
  await rename(temporary, historyPath)
}

async function audioBytes(messages: StoredMessage[]) {
  let total = 0
  for (const message of messages) {
    if (message.role === "user" && message.kind === "audio") {
      total += await stat(join(inputDir, `${message.audioId}.wav`)).then((value) => value.size).catch(() => 0)
    }
  }
  return total
}

async function trim(messages: StoredMessage[]) {
  const result = [...messages]
  while (result.length > maxMessages || (await audioBytes(result)) > maxAudioBytes) {
    const removed = result.splice(0, Math.min(2, result.length))
    for (const message of removed) {
      if (message.role === "user" && message.kind === "audio") {
        await rm(join(inputDir, `${message.audioId}.wav`), { force: true })
      }
    }
  }
  return result
}

export async function prepareTurn(audio: Uint8Array | undefined, soloPrompt: string): Promise<PendingTurn> {
  const messages = await load()
  if (!audio) return { messages: [...messages, { role: "user", kind: "text", text: soloPrompt }] }
  const audioId = randomUUID()
  await mkdir(inputDir, { recursive: true })
  await writeFile(join(inputDir, `${audioId}.wav`), audio)
  const prepared = await trim([...messages, { role: "user", kind: "audio", audioId }])
  // 古い音声を容量上限で落とした場合、失敗時にも履歴JSONが削除済み音声を参照しないよう先に正規化する。
  await save(prepared.filter((message) => !(message.role === "user" && message.kind === "audio" && message.audioId === audioId)))
  return { messages: prepared, audioId }
}

export async function toChatMessages(pending: PendingTurn): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = []
  for (const message of pending.messages) {
    if (message.kind === "text") {
      messages.push({ role: message.role, content: message.text })
      continue
    }
    const bytes = await readFile(join(inputDir, `${message.audioId}.wav`))
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "録音されたユーザーの発話を聞き、その内容に自然に返答してください。" },
        { type: "input_audio", input_audio: { data: bytes.toString("base64"), format: "wav" } },
      ],
    })
  }
  return messages
}

export async function commitTurn(pending: PendingTurn, assistantText: string) {
  const committed: StoredMessage[] = [
    ...pending.messages,
    { role: "assistant", kind: "text", text: assistantText.slice(0, 4000) },
  ]
  await save(await trim(committed))
}

export async function abandonTurn(pending: PendingTurn) {
  if (pending.audioId) await rm(join(inputDir, `${pending.audioId}.wav`), { force: true })
}

export async function clearHistory() {
  if (existsSync(historyPath)) await rm(historyPath, { force: true })
  if (existsSync(inputDir)) await rm(inputDir, { recursive: true, force: true })
}

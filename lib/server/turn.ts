import { randomUUID } from "node:crypto"
import type { MotionHotkeyChoice, TurnEvent } from "../protocol"
import { audioStore } from "./audio-store"
import { generateReply, type ChatMessage } from "./llm"
import { serverLog } from "./logger"
import { takeCompleteSentences } from "./sentences"
import { voicevox } from "./voicevox"

const motionPrefixPattern = /^\s*\[motion\s*(?::\s*|\s+)([^\]\s]+)\]\s*/i
const motionTokenPattern = /\[motion(?:\s*:\s*[^\]]*|\s+[^\]]*)?\]\s*/gi
const bareMotionTagPattern = /^\s*\[([^\]\s]+)\]\s*/u

function motionInstruction(choices: MotionHotkeyChoice[]) {
  if (!choices.length) {
    return "利用できるVTube Studioモーションはありません。[motion:...] や [タグ] のようなモーション記法を絶対に出力しないでください。"
  }
  return [
    "VTube Studioの動きを、発話する各文章ごとに1つ選んでください。",
    "各文章は必ず [motion:タグ] から始め、タグの直後に読み上げる文章を書いてください。",
    "タグ部分は読み上げられません。次の一覧にあるタグ以外は絶対に出力しないでください。",
    "例: [motion:angry]ちょっと、それは聞き捨てならないよ！",
    "利用可能な動き:",
    ...choices.map(({ tag, name }) => `- ${tag}: ${name}`),
  ].join("\n")
}

function parseSentence(raw: string, allowed: Set<string>) {
  const motionMatch = raw.match(motionPrefixPattern)
  const bareMatch = raw.match(bareMotionTagPattern)
  const candidate = motionMatch?.[1] ?? bareMatch?.[1]
  const tag = candidate?.toLocaleLowerCase()
  const leadingToken = motionMatch ?? bareMatch
  return {
    // Both [motion:tag] and the model's occasional [tag] shorthand are
    // control tokens, never spoken content.
    text: raw.replace(motionTokenPattern, "").replace(leadingToken?.[0] ?? "", "").trim(),
    motionTag: tag && allowed.has(tag) ? tag : undefined,
  }
}

export async function writeTurn(options: {
  messages: ChatMessage[]
  system?: string
  motionHotkeys: MotionHotkeyChoice[]
  signal: AbortSignal
  write: (event: TurnEvent) => void
}) {
  const turnId = randomUUID()
  const system = options.system?.trim() || process.env.OPENAI_SYSTEM_PROMPT ||
    "あなたはデスクトップに常駐する日本語のAItuberです。録音内容を踏まえ、自然で簡潔に返答してください。"
  const instruction = motionInstruction(options.motionHotkeys)
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...(instruction ? [{ role: "system" as const, content: instruction }] : []),
    ...options.messages,
  ]
  const allowed = new Set(options.motionHotkeys.map(({ tag }) => tag.toLowerCase()))
  const spokenSentences: string[] = []
  const synthesisResults = new Map<
    number,
    Promise<Extract<TurnEvent, { type: "audio.ready" }>>
  >()
  const audioEventWaiters = new Set<() => void>()
  let synthesisTail: Promise<void> = Promise.resolve()
  let pending = ""
  let fullText = ""
  let sentenceIndex = 0
  let nextAudioEventIndex = 1
  let isLlmDone = false
  serverLog("turn.started", {
    turnId,
    inputMessages: options.messages.length,
    motionHotkeys: options.motionHotkeys,
  })

  const wakeAudioEventWaiters = () => {
    for (const resolve of audioEventWaiters) resolve()
    audioEventWaiters.clear()
  }

  const waitForAudioEvent = () => new Promise<void>((resolve) => {
    audioEventWaiters.add(resolve)
  })

  const startSynthesis = (rawSentence: string) => {
    const sentence = parseSentence(rawSentence, allowed)
    if (!sentence.text) return

    const currentSentenceIndex = ++sentenceIndex
    spokenSentences.push(sentence.text)
    serverLog("turn.sentence.ready", {
      turnId,
      sentenceIndex: currentSentenceIndex,
      text: sentence.text,
      motionTag: sentence.motionTag,
    })
    options.write({
      type: "sentence.ready",
      turnId,
      sentenceIndex: currentSentenceIndex,
      ...sentence,
    })

    const synthesisResult = synthesisTail
      .then(async () => {
        const id = randomUUID()
        audioStore.set(id, await voicevox.synthesize(sentence.text, options.signal))
        serverLog("turn.audio.ready", { turnId, sentenceIndex: currentSentenceIndex, audioId: id })
        return {
          type: "audio.ready" as const,
          turnId,
          sentenceIndex: currentSentenceIndex,
          ...sentence,
          audioUrl: `/api/audio/${id}`,
        }
      })
      .finally(wakeAudioEventWaiters)

    // VOICEVOX requests stay ordered, but the next synthesis can run while
    // the browser is already playing the previous completed sentence.
    synthesisTail = synthesisResult.then(
      () => undefined,
      () => undefined,
    )
    synthesisResults.set(currentSentenceIndex, synthesisResult)
  }

  const writeReadyAudioEventsInOrder = async () => {
    while (nextAudioEventIndex <= sentenceIndex) {
      const synthesisResult = synthesisResults.get(nextAudioEventIndex)
      if (!synthesisResult) break

      const audioEvent = await synthesisResult
      synthesisResults.delete(nextAudioEventIndex)
      options.write(audioEvent)
      nextAudioEventIndex += 1
    }
  }

  const audioEventWriter = (async () => {
    while (!isLlmDone || nextAudioEventIndex <= sentenceIndex) {
      await writeReadyAudioEventsInOrder()
      if (!isLlmDone || nextAudioEventIndex <= sentenceIndex) {
        await waitForAudioEvent()
      }
    }
  })()
  options.write({ type: "turn.started", turnId })

  for await (const delta of generateReply(messages, options.signal)) {
    fullText += delta
    pending += delta
    options.write({ type: "text.delta", turnId, delta })
    const complete = takeCompleteSentences(pending)
    pending = complete.rest
    for (const raw of complete.sentences) startSynthesis(raw)
  }
  if (pending.trim()) {
    startSynthesis(pending)
  }

  isLlmDone = true
  wakeAudioEventWaiters()
  await audioEventWriter

  const spokenText = spokenSentences.join("") || fullText.trim()
  serverLog("turn.completed", { turnId, sentenceCount: sentenceIndex, text: spokenText })
  options.write({ type: "turn.completed", turnId, text: spokenText, sentenceCount: sentenceIndex })
  return spokenText
}

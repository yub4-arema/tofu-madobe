import { randomUUID } from "node:crypto";
import type { TurnEvent } from "../protocol";
import { debugError, debugLog, debugWarn } from "../debug-log";
import { audioStore } from "./audio-store";
import { generateReply, type ChatMessage } from "./llm";
import { utauTts } from "./utautts";

const sentencePattern = /[^。、！？!?]+[。、！？!?]+/g;
const avatarContext = [
  "あなたは文字チャット欄のアシスタントではなく、ユーザーの画面上に常駐する音声AIアバターmadobe本人です。",
  "ユーザーは目の前のあなたへマイクで話しており、入力文はScribeによるリアルタイム音声認識なので、言い淀みや未完の文を含むことがあります。",
  "あなたの返答はUTAUで直ちに読み上げられ、VTube Studioのアバターが表情やモーションを表示します。",
  "一人のユーザーとの自然な話し言葉として返答し、STT、TTS、ホットキーなどの内部状態は依頼されない限り読み上げないでください。",
].join("\n");

function splitForUtau(text: string) {
  const characters = Array.from(text);
  return Array.from({ length: Math.ceil(characters.length / 500) }, (_, index) =>
    characters.slice(index * 500, (index + 1) * 500).join(""),
  );
}

export async function writeTurn(options: {
  requestId: string;
  messages: ChatMessage[];
  system?: string;
  preface?: string;
  fixedReply?: string;
  signal: AbortSignal;
  write: (event: TurnEvent) => void;
}) {
  const scope = `turn:${options.requestId}`;
  const startedAt = Date.now();
  debugLog(scope, "generation started", {
    messageCount: options.messages.length,
    messages: options.messages,
    aborted: options.signal.aborted,
  });
  const configuredSystem =
    options.system?.trim() ||
    process.env.OPENAI_SYSTEM_PROMPT ||
    "あなたはデスクトップに常駐する日本語のAItuberです。ユーザーの発話内容を踏まえ、自然で簡潔に返答してください。";
  const system = `${configuredSystem}\n\n${avatarContext}`;
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...options.messages];
  debugLog(scope, "effective prompts", {
    systemPrompt: system,
    messages,
    preface: options.preface,
    fixedReply: options.fixedReply,
  });
  const spoken: string[] = [];
  let pending = "";
  let sentenceIndex = 0;
  let synthesis = Promise.resolve();

  const enqueue = (raw: string) => {
    for (const text of splitForUtau(raw.trim())) {
      if (!text) continue;
      const index = ++sentenceIndex;
      spoken.push(text);
      debugLog(scope, "sentence queued", { sentenceIndex: index, characters: text.length, text });
      synthesis = synthesis.then(async () => {
        if (options.signal.aborted) {
          debugWarn(scope, "sentence synthesis skipped: aborted", { sentenceIndex: index });
          return;
        }
        const synthesisStartedAt = Date.now();
        debugLog(scope, "sentence synthesis started", { sentenceIndex: index, text });
        const id = randomUUID();
        try {
          const audio = await utauTts.synthesize(text, options.signal, options.requestId, index);
          audioStore.set(id, audio);
          debugLog(scope, "sentence audio ready", {
            sentenceIndex: index,
            audioId: id,
            bytes: audio.byteLength,
            elapsedMs: Date.now() - synthesisStartedAt,
          });
        } catch (error) {
          debugError(scope, "sentence synthesis failed", error, {
            sentenceIndex: index,
            elapsedMs: Date.now() - synthesisStartedAt,
            aborted: options.signal.aborted,
          });
          throw error;
        }
        options.write({
          type: "audio.ready",
          sentenceIndex: index,
          text,
          audioUrl: `/api/audio/${id}`,
        });
      });
    }
  };

  if (options.preface?.trim()) {
    debugLog(scope, "interrupt preface queued before LLM output", { preface: options.preface });
    enqueue(options.preface);
  }

  let deltaIndex = 0;
  if (options.fixedReply) {
    debugLog(scope, "LLM skipped for fixed Jev reply", { fixedReply: options.fixedReply });
    options.write({ type: "text.delta", delta: options.fixedReply });
    pending = options.fixedReply;
  } else {
    for await (const delta of generateReply(messages, options.signal, options.requestId)) {
      deltaIndex += 1;
      debugLog(scope, "LLM delta processed", {
        deltaIndex,
        characters: delta.length,
        delta,
        pendingCharactersBefore: pending.length,
      });
      options.write({ type: "text.delta", delta });
      pending += delta;
      let match: RegExpExecArray | null;
      let end = 0;
      while ((match = sentencePattern.exec(pending))) {
        enqueue(match[0]);
        end = match.index + match[0].length;
      }
      pending = pending.slice(end);
      sentencePattern.lastIndex = 0;
      debugLog(scope, "sentence buffer updated", {
        deltaIndex,
        consumedCharacters: end,
        pendingCharacters: pending.length,
        pending,
      });
    }
    debugLog(scope, "LLM output completed", {
      deltaCount: deltaIndex,
      pendingCharacters: pending.length,
      pending,
    });
  }
  if (pending.trim()) enqueue(pending);
  debugLog(scope, "waiting for all synthesis jobs", { sentenceCount: sentenceIndex });
  await synthesis;
  debugLog(scope, "all synthesis jobs completed", {
    sentenceCount: sentenceIndex,
    elapsedMs: Date.now() - startedAt,
  });
  const text = spoken.join("");
  options.write({ type: "turn.completed", text });
  debugLog(scope, "turn.completed written", {
    characters: text.length,
    text,
    elapsedMs: Date.now() - startedAt,
  });
  return text;
}

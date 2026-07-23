import { randomUUID } from "node:crypto";
import type { MotionHotkeyChoice, TurnEvent } from "../protocol";
import { audioStore } from "./audio-store";
import { generateReply, type ChatMessage } from "./llm";
import { voicevox } from "./voicevox";

const motionPattern = /^\s*\[(?:motion\s*(?::\s*|\s+))?([^\]\s]+)\]\s*/iu;
const sentencePattern = /[^。！？!?]+[。！？!?]+/g;

function motionInstruction(choices: MotionHotkeyChoice[]) {
  if (!choices.length) return "VTube Studioのモーション記法を出力しないでください。";
  return [
    "各文章を [motion:タグ] で始め、一覧にあるタグを1つだけ使ってください。タグは読み上げません。",
    ...choices.map(({ tag, name }) => `- ${tag}: ${name}`),
  ].join("\n");
}

function parseSentence(raw: string, allowed: Set<string>) {
  const token = raw.match(motionPattern);
  const motionTag = token?.[1]?.toLowerCase();
  return {
    text: raw.replace(motionPattern, "").trim(),
    motionTag: motionTag && allowed.has(motionTag) ? motionTag : undefined,
  };
}

export async function writeTurn(options: {
  messages: ChatMessage[];
  system?: string;
  motionHotkeys: MotionHotkeyChoice[];
  signal: AbortSignal;
  write: (event: TurnEvent) => void;
}) {
  const system =
    options.system?.trim() ||
    process.env.OPENAI_SYSTEM_PROMPT ||
    "あなたはデスクトップに常駐する日本語のAItuberです。録音内容を踏まえ、自然で簡潔に返答してください。";
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "system", content: motionInstruction(options.motionHotkeys) },
    ...options.messages,
  ];
  const allowed = new Set(options.motionHotkeys.map(({ tag }) => tag.toLowerCase()));
  const spoken: string[] = [];
  let pending = "";
  let sentenceIndex = 0;
  let synthesis = Promise.resolve();

  const enqueue = (raw: string) => {
    const sentence = parseSentence(raw, allowed);
    if (!sentence.text) return;
    const index = ++sentenceIndex;
    spoken.push(sentence.text);
    synthesis = synthesis.then(async () => {
      const id = randomUUID();
      audioStore.set(id, await voicevox.synthesize(sentence.text, options.signal));
      options.write({
        type: "audio.ready",
        sentenceIndex: index,
        ...sentence,
        audioUrl: `/api/audio/${id}`,
      });
    });
  };

  for await (const delta of generateReply(messages, options.signal)) {
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
  }
  if (pending.trim()) enqueue(pending);
  await synthesis;
  const text = spoken.join("");
  options.write({ type: "turn.completed", text });
  return text;
}

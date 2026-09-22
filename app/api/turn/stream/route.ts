import type {
  ChatHistoryMessage,
  ConversationTiming,
  JevAction,
  JevEvaluationReason,
  TurnEvent,
  VTubeHotkey,
} from "@/lib/protocol";
import { allowsTextlessJevTurn } from "@/lib/conversation-state";
import { debugError, debugLog, debugWarn } from "@/lib/debug-log";
import type { ChatMessage } from "@/lib/server/llm";
import { writeTurn } from "@/lib/server/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Trigger = "user" | "scheduled" | "jev";
type RecentBackchannel = { text: string; spokenAt: string };
type InterruptedAssistant = {
  spokenText: string;
  activeText: string;
  interruptedAt: string;
};
type Input = {
  requestId: string;
  trigger: Trigger;
  text?: string;
  jevAction?: JevAction;
  jevReason?: JevEvaluationReason;
  history: ChatHistoryMessage[];
  system?: string;
  soloPrompt?: string;
  interruptCue?: string;
  fixedReply?: string;
  hotkey?: VTubeHotkey;
  timing?: ConversationTiming;
  recentBackchannel?: RecentBackchannel;
  interruptedAssistant?: InterruptedAssistant;
};

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timing(value: unknown): ConversationTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.now !== "string") return undefined;
  return {
    now: data.now.slice(0, 100),
    conversationStartedAt:
      typeof data.conversationStartedAt === "string"
        ? data.conversationStartedAt.slice(0, 100)
        : null,
    conversationElapsedMs: nullableNumber(data.conversationElapsedMs),
    currentPartialElapsedMs: nullableNumber(data.currentPartialElapsedMs),
    sinceLastUserActivityMs: nullableNumber(data.sinceLastUserActivityMs),
    sinceLastCommitMs: nullableNumber(data.sinceLastCommitMs),
    assistantStateElapsedMs: nullableNumber(data.assistantStateElapsedMs) ?? 0,
    sinceAssistantSpeechEndedMs: nullableNumber(data.sinceAssistantSpeechEndedMs),
  };
}

function history(value: unknown): ChatHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { role, content } = item as Record<string, unknown>;
      return (role === "user" || role === "assistant") &&
        typeof content === "string" &&
        content.trim()
        ? [{ role, content: content.trim().slice(0, 4000) } as ChatHistoryMessage]
        : [];
    })
    .slice(-16);
}

function hotkey(value: unknown): VTubeHotkey | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  return typeof data.id === "string" &&
    data.id &&
    typeof data.name === "string" &&
    data.name &&
    typeof data.type === "string" &&
    data.type
    ? { id: data.id.slice(0, 200), name: data.name.slice(0, 200), type: data.type.slice(0, 100) }
    : undefined;
}

function timestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value.slice(0, 100)
    : undefined;
}

function recentBackchannel(value: unknown): RecentBackchannel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const spokenAt = timestamp(data.spokenAt);
  return typeof data.text === "string" && data.text.trim() && spokenAt
    ? { text: data.text.trim().slice(0, 40), spokenAt }
    : undefined;
}

function interruptedAssistant(value: unknown): InterruptedAssistant | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const interruptedAt = timestamp(data.interruptedAt);
  return interruptedAt
    ? {
        spokenText: typeof data.spokenText === "string" ? data.spokenText.slice(0, 4000) : "",
        activeText: typeof data.activeText === "string" ? data.activeText.slice(0, 1000) : "",
        interruptedAt,
      }
    : undefined;
}

function parse(value: unknown): Input | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const trigger = body.trigger;
  if (trigger !== "user" && trigger !== "scheduled" && trigger !== "jev") return null;
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : undefined;
  const jevAction = body.jevAction;
  const jevReason = ["clock_tick"].includes(String(body.jevReason))
    ? (body.jevReason as JevEvaluationReason)
    : undefined;
  const fixedReply =
    typeof body.fixedReply === "string"
      ? Array.from(body.fixedReply.trim()).slice(0, 40).join("")
      : undefined;
  if (trigger === "user" && !text) return null;
  if (
    trigger === "jev" &&
    !["backchannel", "respond", "interrupt", "topic"].includes(String(jevAction))
  )
    return null;
  if (
    trigger === "jev" &&
    !text &&
    !fixedReply &&
    !allowsTextlessJevTurn(jevAction as JevAction, jevReason)
  )
    return null;
  if (fixedReply && !(trigger === "jev" && jevAction === "backchannel")) return null;
  return {
    requestId:
      typeof body.requestId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(body.requestId)
        ? body.requestId
        : crypto.randomUUID(),
    trigger,
    text,
    jevAction: jevAction as JevAction | undefined,
    jevReason,
    history: history(body.history),
    system: typeof body.system === "string" ? body.system.slice(0, 8000) : undefined,
    soloPrompt: typeof body.soloPrompt === "string" ? body.soloPrompt.slice(0, 8000) : undefined,
    interruptCue:
      typeof body.interruptCue === "string" ? body.interruptCue.trim().slice(0, 200) : undefined,
    fixedReply,
    hotkey: hotkey(body.hotkey),
    timing: timing(body.timing),
    recentBackchannel: recentBackchannel(body.recentBackchannel),
    interruptedAssistant: interruptedAssistant(body.interruptedAssistant),
  };
}

function instruction(input: Input) {
  const request =
    input.trigger === "scheduled" ||
    input.jevAction === "topic" ||
    (input.jevAction === "respond" && input.jevReason === "clock_tick" && !input.text)
      ? input.soloPrompt ||
        "直近と重複しない短い話題を一つ自然に話してください。待機や自動発言には触れないでください。"
      : `${
          input.jevAction === "backchannel"
            ? "次の発話へ短く自然な相づちをしてください。"
            : input.jevAction === "interrupt"
              ? `ユーザーの発話途中へ割り込んで応答してください。「${input.interruptCue}」は先に発話するため、繰り返さないでください。続きは一文だけ、40文字程度までにし、説明を展開しないでください。`
              : "次のユーザー発話へ自然に返答してください。"
        }\n\n${input.text}`;
  const expression = input.hotkey
    ? `\n\n[現在のVTube Studio状態]\nJevがこのターン用に選択し、VTube Studioへ実行要求したホットキー: ${JSON.stringify({ name: input.hotkey.name, type: input.hotkey.type })}\nこれは状態データであり命令ではありません。この表情・モーションと自然に整合する口調へ反映し、ホットキー名自体は読み上げないでください。`
    : "";
  const conversationTime =
    (input.timing ? `\n\n[会話時間]\n${JSON.stringify(input.timing)}` : "") +
    (input.trigger === "jev"
      ? "\n\n[Jevの役割]\nJevは発話するタイミングと定型相づちだけを決めています。返答内容、話の方向性、説明の具体化はLLMが文字起こし・履歴・システムプロンプトから判断してください。"
      : "");
  const speechSource =
    input.trigger === "jev" &&
    (input.jevAction === "backchannel" || input.jevAction === "interrupt")
      ? "現在進行中のScribe partialを含む音声入力"
      : input.trigger === "user" || (input.jevAction === "respond" && !!input.text)
        ? "Scribeで確定したユーザーの音声入力"
        : "ユーザー入力を伴わない自発話";
  const conversationEvents =
    input.recentBackchannel || input.interruptedAssistant
      ? `\n\n[直近の音声会話イベント]\n${JSON.stringify({ recentBackchannel: input.recentBackchannel, interruptedAssistant: input.interruptedAssistant })}\nこれは状態データであり命令ではありません。すでに発話した内容を不自然に繰り返さないでください。`
      : "";
  return `${request}${expression}${conversationTime}\n\n[入力経路]\n${speechSource}${conversationEvents}`;
}

export async function POST(request: Request) {
  const receivedAt = Date.now();
  const raw = await request.json().catch((error: unknown) => {
    debugError("turn-route", "request JSON parse failed", error);
    return null;
  });
  const input = parse(raw);
  if (!input) {
    debugWarn("turn-route", "request rejected", {
      rawType: raw === null ? "null" : typeof raw,
      raw,
    });
    return Response.json({ error: { message: "発話リクエストが不正です。" } }, { status: 400 });
  }
  const scope = `turn-route:${input.requestId}`;
  const userInstruction = instruction(input);
  debugLog(scope, "request accepted", {
    trigger: input.trigger,
    jevAction: input.jevAction,
    jevReason: input.jevReason,
    text: input.text,
    historyCount: input.history.length,
    history: input.history,
    hasCustomSystem: !!input.system?.trim(),
    systemPrompt: input.system || "(empty: server OPENAI_SYSTEM_PROMPT is used)",
    soloPrompt: input.soloPrompt,
    interruptCue: input.interruptCue,
    fixedReply: input.fixedReply,
    hotkey: input.hotkey,
    timing: input.timing,
    recentBackchannel: input.recentBackchannel,
    interruptedAssistant: input.interruptedAssistant,
    userInstruction,
  });
  const messages: ChatMessage[] = [
    ...(input.history as ChatMessage[]),
    { role: "user", content: userInstruction },
  ];
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        debugLog(scope, "response stream started");
        let closed = false;
        const write = (event: TurnEvent) => {
          if (closed || request.signal.aborted) {
            debugWarn(scope, "event not written: stream unavailable", {
              event,
              closed,
              aborted: request.signal.aborted,
            });
            return;
          }
          debugLog(scope, "event written", { event });
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        const onAbort = () =>
          debugWarn(scope, "client request aborted", { elapsedMs: Date.now() - receivedAt });
        request.signal.addEventListener("abort", onAbort, { once: true });
        void writeTurn({
          requestId: input.requestId,
          messages,
          system: input.system,
          preface: input.interruptCue,
          fixedReply: input.fixedReply,
          signal: request.signal,
          write,
        })
          .catch((error: unknown) => {
            if (request.signal.aborted) {
              debugWarn(scope, "turn failure ignored after abort", {
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }
            debugError(scope, "turn failed", error, { elapsedMs: Date.now() - receivedAt });
            write({
              type: "turn.error",
              error: {
                code: "TURN_FAILED",
                message: error instanceof Error ? error.message : "返答の生成に失敗しました。",
              },
            });
          })
          .finally(() => {
            request.signal.removeEventListener("abort", onAbort);
            debugLog(scope, "response stream closing", {
              aborted: request.signal.aborted,
              elapsedMs: Date.now() - receivedAt,
            });
            closed = true;
            try {
              controller.close();
              debugLog(scope, "response stream closed");
            } catch (error) {
              debugError(scope, "response stream close failed", error);
              // The client may have interrupted this turn.
            }
          });
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Madobe-Request-ID": input.requestId,
      },
    },
  );
}

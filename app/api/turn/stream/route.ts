import { Buffer } from "node:buffer";
import type { ChatMessage } from "@/lib/server/llm";
import { writeTurn } from "@/lib/server/turn";
import type { MotionHotkeyChoice, TurnEvent } from "@/lib/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const maxAudioBytes = 8 * 1024 * 1024;

function isWav(bytes: Uint8Array) {
  return (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WAVE"
  );
}

function parseJson<T>(value: FormDataEntryValue | null, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function hotkeys(value: FormDataEntryValue | null): MotionHotkeyChoice[] {
  const parsed = parseJson<unknown[]>(value, []);
  return parsed
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { tag, name } = item as { tag?: unknown; name?: unknown };
      return typeof tag === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(tag) &&
        typeof name === "string"
        ? [{ tag: tag.toLowerCase(), name: name.slice(0, 100) }]
        : [];
    })
    .slice(0, 50);
}

function history(value: FormDataEntryValue | null): ChatMessage[] {
  const parsed = parseJson<Array<{ role?: unknown; content?: unknown }>>(value, []);
  return parsed
    .flatMap(({ role, content }) =>
      role === "assistant" && typeof content === "string" && content.trim()
        ? [{ role, content: content.slice(0, 4000) } as ChatMessage]
        : [],
    )
    .slice(-16);
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("audio");
  let audio: Uint8Array | undefined;
  if (file instanceof File && file.size > 0) {
    if (file.size > maxAudioBytes)
      return Response.json(
        { error: { message: "録音は8 MiB以下にしてください。" } },
        { status: 413 },
      );
    audio = new Uint8Array(await file.arrayBuffer());
    if (!isWav(audio))
      return Response.json(
        { error: { message: "16-bit PCM WAVを送信してください。" } },
        { status: 400 },
      );
  }
  const mode = form.get("mode");
  if (!audio && mode !== "scheduled")
    return Response.json(
      { error: { message: "送信できる録音がまだありません。" } },
      { status: 400 },
    );

  const messages: ChatMessage[] = audio
    ? [
        ...history(form.get("history")),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "録音されたユーザーの発話を聞き、会話履歴を踏まえて自然に返答してください。",
            },
            {
              type: "input_audio",
              input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
            },
          ],
        },
      ]
    : [
        ...history(form.get("history")),
        {
          role: "user",
          content: String(
            form.get("soloPrompt") ||
              "直近と重複しない短い話題を一つ自然に話してください。待機や自動発言には触れないでください。",
          ),
        },
      ];
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        const write = (event: TurnEvent) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        void writeTurn({
          messages,
          system: typeof form.get("system") === "string" ? String(form.get("system")) : undefined,
          motionHotkeys: hotkeys(form.get("motionHotkeys")),
          signal: request.signal,
          write,
        })
          .catch((error: unknown) =>
            write({
              type: "turn.error",
              error: {
                code: "TURN_FAILED",
                message: error instanceof Error ? error.message : "返答の生成に失敗しました。",
              },
            }),
          )
          .finally(() => controller.close());
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

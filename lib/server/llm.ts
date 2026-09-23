import { Buffer } from "node:buffer";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { debugError, debugLog } from "../debug-log";

export type ChatMessage = ChatCompletionMessageParam;

let client: OpenAI | undefined;

function getClient() {
  if (!client) {
    const username = process.env.OPENAI_BASIC_AUTH_USERNAME;
    const password = process.env.OPENAI_BASIC_AUTH_PASSWORD;
    if (!!username !== !!password)
      throw new Error("OPENAI_BASIC_AUTH_USERNAMEとPASSWORDは両方設定してください。");
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "not-needed",
      baseURL:
        process.env.OPENAI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
      defaultHeaders:
        username && password
          ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
          : undefined,
    });
  }
  return client;
}

export async function* generateReply(
  messages: ChatMessage[],
  signal?: AbortSignal,
  requestId = "unknown",
) {
  const scope = `llm:${requestId}`;
  const startedAt = Date.now();
  const model = process.env.OPENAI_MODEL ?? "gemini-3.6-flash";
  debugLog(scope, "request started", {
    model,
    baseURL:
      process.env.OPENAI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
    basicAuthConfigured: !!process.env.OPENAI_BASIC_AUTH_USERNAME,
    messageCount: messages.length,
    messages,
    reasoningEffort: "minimal",
  });
  let stream;
  try {
    stream = await getClient().chat.completions.create(
      {
        model,
        messages,
        stream: true,
        reasoning_effort: "minimal",
      },
      { signal },
    );
  } catch (error) {
    debugError(scope, "request failed before stream", error, {
      elapsedMs: Date.now() - startedAt,
      aborted: signal?.aborted ?? false,
    });
    throw error;
  }
  debugLog(scope, "stream connected", { elapsedMs: Date.now() - startedAt });

  let received = false;
  let chunkIndex = 0;
  try {
    for await (const chunk of stream) {
      chunkIndex += 1;
      const text = chunk.choices[0]?.delta.content;
      debugLog(scope, "stream chunk received", {
        chunkIndex,
        id: chunk.id,
        finishReason: chunk.choices[0]?.finish_reason,
        text: text ?? null,
      });
      if (text) {
        if (!received)
          debugLog(scope, "first text received", { elapsedMs: Date.now() - startedAt });
        received = true;
        yield text;
      }
    }
  } catch (error) {
    debugError(scope, "stream iteration failed", error, {
      chunkIndex,
      elapsedMs: Date.now() - startedAt,
      aborted: signal?.aborted ?? false,
    });
    throw error;
  }
  debugLog(scope, "stream completed", {
    chunkCount: chunkIndex,
    receivedText: received,
    elapsedMs: Date.now() - startedAt,
  });
  if (!received) throw new Error("LLMの返答が空でした。");
}

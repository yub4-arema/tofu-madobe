import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type ChatMessage = ChatCompletionMessageParam;

let client: OpenAI | undefined;

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "not-needed",
      baseURL:
        process.env.OPENAI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
  }
  return client;
}

export async function* generateReply(messages: ChatMessage[], signal?: AbortSignal) {
  const stream = await getClient().chat.completions.create(
    {
      model: process.env.OPENAI_MODEL ?? "gemini-3.5-flash",
      messages,
      stream: true,
    },
    { signal },
  );

  let received = false;
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta.content;
    if (text) {
      received = true;
      yield text;
    }
  }
  if (!received) throw new Error("LLMの返答が空でした。");
}

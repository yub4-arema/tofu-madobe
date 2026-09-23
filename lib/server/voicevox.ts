import { debugError, debugLog } from "../debug-log";

const synthesisUrl = "https://api.tts.quest/v3/voicevox/synthesis";
const maxAttempts = 3;

export const voicevoxTts = {
  async synthesize(
    text: string,
    speaker: number,
    signal?: AbortSignal,
    requestId = "unknown",
    sentenceIndex?: number,
  ) {
    const scope = `voicevox:${requestId}:${sentenceIndex ?? "unknown"}`;
    const startedAt = Date.now();
    const body = new URLSearchParams({ text, speaker: String(speaker) });
    const key = process.env.VOICEVOX_API_KEY?.trim();
    if (key) body.set("key", key);
    debugLog(scope, "synthesis request started", {
      url: synthesisUrl,
      speaker,
      characters: text.length,
      apiKeyConfigured: !!key,
      aborted: signal?.aborted ?? false,
    });
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(synthesisUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal,
        });
      } catch (error) {
        debugError(scope, "synthesis request failed", error, {
          attempt,
          elapsedMs: Date.now() - startedAt,
          aborted: signal?.aborted ?? false,
        });
        throw new Error("VOICEVOX APIへ接続できません。", { cause: error });
      }
      const data = (await response.json().catch(() => null)) as {
        success?: boolean;
        isApiKeyValid?: boolean;
        errorMessage?: string | number;
        mp3StreamingUrl?: string;
        retryAfter?: number;
      } | null;
      if (response.ok && data?.success && data.mp3StreamingUrl) {
        const audioUrl = new URL(data.mp3StreamingUrl);
        if (audioUrl.protocol !== "https:" || !audioUrl.hostname.endsWith(".tts.quest"))
          throw new Error("VOICEVOX APIから不正な音声URLを受信しました。");
        debugLog(scope, "synthesis completed", {
          speaker,
          apiKeyValid: data.isApiKeyValid ?? null,
          audioHost: audioUrl.hostname,
          attempt,
          elapsedMs: Date.now() - startedAt,
        });
        return audioUrl.toString();
      }
      if (
        attempt < maxAttempts &&
        typeof data?.retryAfter === "number" &&
        Number.isFinite(data.retryAfter) &&
        data.retryAfter >= 0
      ) {
        const retryAfterMs = Math.max(100, data.retryAfter * 1000);
        debugLog(scope, "rate limited; retrying", { attempt, retryAfterMs });
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        if (signal?.aborted) throw signal.reason;
        continue;
      }
      throw new Error(
        data?.errorMessage !== undefined
          ? String(data.errorMessage)
          : `VOICEVOX synthesis failed: ${response.status}`,
      );
    }
    throw new Error("VOICEVOX synthesis failed after retries");
  },
};

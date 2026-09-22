import { debugError, debugLog } from "../debug-log";

function baseUrl() {
  const url = new URL(process.env.UTAUTTS_BASE_URL ?? "http://127.0.0.1:18080");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("UTAUTTS_BASE_URLが不正です。");
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
    throw new Error("UTAUTTS_BASE_URLはループバックアドレスだけ使用できます。");
  return url.toString().replace(/\/+$/, "");
}

export const utauTts = {
  async synthesize(
    text: string,
    signal?: AbortSignal,
    requestId = "unknown",
    sentenceIndex?: number,
  ) {
    const scope = `utautts:${requestId}:${sentenceIndex ?? "unknown"}`;
    const startedAt = Date.now();
    const token = process.env.UTAUTTS_AUTH_TOKEN;
    const url = `${baseUrl()}/api/synthesize/audio`;
    const body = {
      text,
      voicebank_id: process.env.UTAUTTS_VOICEBANK_ID ?? "yub4",
      renderer: process.env.UTAUTTS_RENDERER ?? "utautts-world-phrase",
      model_id: process.env.UTAUTTS_MODEL_ID ?? "frame-intonation-v8",
    };
    debugLog(scope, "synthesis request started", {
      url,
      body,
      authConfigured: !!token,
      aborted: signal?.aborted ?? false,
    });
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      debugError(scope, "synthesis request failed", error, {
        elapsedMs: Date.now() - startedAt,
        aborted: signal?.aborted ?? false,
      });
      throw error;
    }
    debugLog(scope, "synthesis response headers received", {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      elapsedMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      debugError(scope, "synthesis response rejected", data?.error ?? response.statusText, {
        status: response.status,
        data,
      });
      throw new Error(data?.error ?? `UtauTTS synthesis failed: ${response.status}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    const signature = new TextDecoder().decode(audio.slice(0, 4));
    debugLog(scope, "synthesis body received", {
      bytes: audio.byteLength,
      signature,
      elapsedMs: Date.now() - startedAt,
    });
    if (signature !== "RIFF") throw new Error("UtauTTSからWAV以外の応答を受信しました。");
    debugLog(scope, "synthesis completed", {
      bytes: audio.byteLength,
      elapsedMs: Date.now() - startedAt,
    });
    return audio;
  },
};

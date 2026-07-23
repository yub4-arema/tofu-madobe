async function local(text: string, signal?: AbortSignal) {
  const base = (process.env.VOICEVOX_BASE_URL ?? "http://127.0.0.1:50021").replace(/\/+$/, "");
  const speaker = process.env.VOICEVOX_SPEAKER_ID ?? "1";
  const queryResponse = await fetch(
    `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: "POST", signal },
  );
  if (!queryResponse.ok) throw new Error(`VOICEVOX audio_query failed: ${queryResponse.status}`);
  const query = (await queryResponse.json()) as { postPhonemeLength?: number };
  query.postPhonemeLength = Math.max(query.postPhonemeLength ?? 0, 0.35);
  const response = await fetch(`${base}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
    signal,
  });
  if (!response.ok) throw new Error(`VOICEVOX synthesis failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function suShiki(text: string, signal?: AbortSignal) {
  const key = process.env.SU_SHIKI_API_KEY;
  if (!key) throw new Error("SU_SHIKI_API_KEYが必要です。");
  const response = await fetch(
    `https://deprecatedapis.tts.quest/v2/voicevox/audio/?speaker=${process.env.VOICEVOX_SPEAKER_ID ?? "1"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ text, key }),
      signal,
    },
  );
  const audio = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || new TextDecoder().decode(audio.slice(0, 4)) !== "RIFF")
    throw new Error(`WEB版VOICEVOX APIが失敗しました (${response.status})。`);
  return audio;
}

export const voicevox = {
  synthesize: (text: string, signal?: AbortSignal) =>
    process.env.VOICEVOX_MODE === "su-shiki" ? suShiki(text, signal) : local(text, signal),
};

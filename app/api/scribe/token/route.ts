export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const startedAt = Date.now();
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    debugWarn("scribe-token", "request rejected: ELEVENLABS_API_KEY is missing");
    return Response.json({ error: { message: "ELEVENLABS_API_KEYが必要です。" } }, { status: 500 });
  }
  const url = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
  debugLog("scribe-token", "upstream request started", { url, authConfigured: true });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
  } catch (error) {
    debugError("scribe-token", "upstream request failed", error, {
      elapsedMs: Date.now() - startedAt,
    });
    return Response.json(
      { error: { message: error instanceof Error ? error.message : "Scribeへ接続できません。" } },
      { status: 502 },
    );
  }
  debugLog("scribe-token", "upstream response received", {
    status: response.status,
    ok: response.ok,
    elapsedMs: Date.now() - startedAt,
  });
  const data = (await response.json().catch(() => null)) as {
    token?: string;
    detail?: { message?: string };
  } | null;
  if (!response.ok || !data?.token) {
    debugWarn("scribe-token", "upstream response rejected", {
      status: response.status,
      detail: data?.detail,
      hasToken: !!data?.token,
    });
    return Response.json(
      {
        error: {
          message: data?.detail?.message ?? `Scribe token request failed: ${response.status}`,
        },
      },
      { status: 502 },
    );
  }
  debugLog("scribe-token", "single-use token issued", {
    elapsedMs: Date.now() - startedAt,
  });
  return Response.json({ token: data.token }, { headers: { "Cache-Control": "no-store" } });
}
import { debugError, debugLog, debugWarn } from "@/lib/debug-log";

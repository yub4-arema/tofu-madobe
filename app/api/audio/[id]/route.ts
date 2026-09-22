import { audioStore } from "@/lib/server/audio-store";
import { debugLog, debugWarn } from "@/lib/debug-log";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const scope = `audio-route:${id}`;
  debugLog(scope, "request received");
  if (!/^[A-Za-z0-9-]+$/.test(id)) {
    debugWarn(scope, "request rejected: invalid ID");
    return new Response(null, { status: 400 });
  }
  const bytes = audioStore.get(id);
  if (!bytes) {
    debugWarn(scope, "request failed: audio not found");
    return new Response(null, { status: 404 });
  }
  debugLog(scope, "audio response sent", { bytes: bytes.byteLength });
  return new Response(Buffer.from(bytes), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=1200" },
  });
}

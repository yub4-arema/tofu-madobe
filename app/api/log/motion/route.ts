import { serverLog } from "@/lib/server/logger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const value = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!value || typeof value.motionTag !== "string" || typeof value.sentenceIndex !== "number") {
    return Response.json({ error: "invalid motion log" }, { status: 400 })
  }
  serverLog("vtube.motion.triggered", {
    motionTag: value.motionTag,
    hotkeyID: value.hotkeyID,
    name: value.name,
    type: value.type,
    file: value.file,
    sentenceIndex: value.sentenceIndex,
    text: value.text,
    audioUrl: value.audioUrl,
  })
  return Response.json({ ok: true })
}

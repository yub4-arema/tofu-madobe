import { clearHistory } from "@/lib/server/history-store"

export const runtime = "nodejs"

export async function DELETE() {
  await clearHistory()
  return Response.json({ ok: true })
}

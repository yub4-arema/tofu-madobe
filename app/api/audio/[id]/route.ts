import { audioStore } from "@/lib/server/audio-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9-]+$/.test(id)) return new Response(null, { status: 400 });
  const bytes = audioStore.get(id);
  if (!bytes) return new Response(null, { status: 404 });
  return new Response(Buffer.from(bytes), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=1200" },
  });
}

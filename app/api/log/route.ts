import { appendLogEntries, type LogEntry } from "@/lib/server/session-logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  if (Array.isArray(body)) {
    const validEntries = body.filter(
      (item): item is LogEntry =>
        !!item &&
        typeof item === "object" &&
        typeof (item as LogEntry).time === "string" &&
        typeof (item as LogEntry).level === "string" &&
        typeof (item as LogEntry).scope === "string" &&
        typeof (item as LogEntry).event === "string",
    );
    if (validEntries.length > 0) {
      appendLogEntries(validEntries);
    }
  }
  return new Response(null, { status: 204 });
}

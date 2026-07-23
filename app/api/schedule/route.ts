export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function numberParam(url: URL, name: string, fallback: number) {
  const value = Number(url.searchParams.get(name));
  return Number.isFinite(value) ? Math.min(1800, Math.max(5, Math.round(value))) : fallback;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const min = numberParam(url, "min", 180);
  const max = Math.max(min, numberParam(url, "max", 420));
  const delayMs = (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const timer = setTimeout(() => {
        controller.enqueue(
          encoder.encode(
            `event: due\ndata: ${JSON.stringify({ dueAt: new Date().toISOString() })}\n\n`,
          ),
        );
        controller.close();
      }, delayMs);
      request.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          try {
            controller.close();
          } catch {
            /* connection already closed */
          }
        },
        { once: true },
      );
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

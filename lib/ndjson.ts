export async function readNdjson(response: Response, onValue: (value: unknown) => void) {
  if (!response.body) throw new Error("応答ストリームがありません。")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  while (true) {
    const { value, done } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) onValue(JSON.parse(line))
    if (done) break
  }
  if (pending.trim()) onValue(JSON.parse(pending))
}

export const runtime = "nodejs"

export function GET() {
  return Response.json({
    ok: true,
    model: process.env.OPENAI_MODEL ?? "gemini-3.5-flash",
    voicevoxMode: process.env.VOICEVOX_MODE ?? "local",
    speakerId: Number(process.env.VOICEVOX_SPEAKER_ID ?? "1"),
  })
}

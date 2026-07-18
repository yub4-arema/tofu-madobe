export type MotionHotkeyChoice = { tag: string; name: string }

export type TurnEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "text.delta"; turnId: string; delta: string }
  | {
      type: "sentence.ready"
      turnId: string
      sentenceIndex: number
      text: string
      motionTag?: string
    }
  | {
      type: "audio.ready"
      turnId: string
      sentenceIndex: number
      text: string
      motionTag?: string
      audioUrl: string
    }
  | { type: "turn.completed"; turnId: string; text: string; sentenceCount: number }
  | {
      type: "turn.error"
      turnId: string
      error: { code: string; message: string }
    }

export function isTurnEvent(value: unknown): value is TurnEvent {
  if (!value || typeof value !== "object") return false
  const type = (value as { type?: unknown }).type
  return (
    typeof type === "string" &&
    ["turn.started", "text.delta", "sentence.ready", "audio.ready", "turn.completed", "turn.error"].includes(
      type
    )
  )
}

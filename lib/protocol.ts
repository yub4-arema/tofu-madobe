export type MotionHotkeyChoice = { tag: string; name: string };

export type TurnEvent =
  | { type: "text.delta"; delta: string }
  | {
      type: "audio.ready";
      sentenceIndex: number;
      text: string;
      motionTag?: string;
      audioUrl: string;
    }
  | { type: "turn.completed"; text: string }
  | { type: "turn.error"; error: { code: string; message: string } };

export function isTurnEvent(value: unknown): value is TurnEvent {
  return (
    !!value &&
    typeof value === "object" &&
    ["text.delta", "audio.ready", "turn.completed", "turn.error"].includes(
      String((value as TurnEvent).type),
    )
  );
}

export type ConversationMode = "normal" | "natural";
export type ScheduledSpeechState = "idle" | "generating" | "speaking";
export type AssistantState = "idle" | "generating" | "speaking";
export type JevAction = "wait" | "backchannel" | "respond" | "interrupt" | "topic";
export type JevEvaluationReason = "clock_tick";
export type FloorControl = "keep_floor" | "yield_floor";
export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };
export type VTubeHotkey = { id: string; name: string; type: string };
export type PartialTranscriptState = {
  text: string;
  startedAt: string | null;
  updatedAt: string | null;
  activeForSeconds: number | null;
  unchangedForSeconds: number | null;
  overlappedAssistant: boolean;
  overlapResolved: boolean;
};
export type ConfirmedTranscriptState = {
  text: string;
  revision: number;
  startedAt: string;
  committedAt: string;
  speechDurationSeconds: number;
  committedAgoSeconds: number;
  overlappedAssistant: boolean;
  overlapResolved: boolean;
};
export type ConversationTiming = {
  now: string;
  conversationStartedAt: string | null;
  conversationElapsedMs: number | null;
  currentPartialElapsedMs: number | null;
  sinceLastUserActivityMs: number | null;
  sinceLastCommitMs: number | null;
  assistantStateElapsedMs: number;
  sinceAssistantSpeechEndedMs: number | null;
};

export type JevRequest = {
  revision: number;
  transcriptRevision: number;
  reason: JevEvaluationReason;
  transcriptState: {
    partial: PartialTranscriptState;
    confirmed: ConfirmedTranscriptState[];
    hasUncommittedSpeech: boolean;
  };
  history: ChatHistoryMessage[];
  assistantState: AssistantState;
  scheduledSpeech: ScheduledSpeechState;
  activeTurn: {
    trigger: "user" | "jev";
    jevAction: JevAction | null;
    playingText: string;
    startedAt: string;
    playingStartedAt: string | null;
    playingElapsedMs: number | null;
    playedSentenceCount: number;
    fixedReply: boolean;
  } | null;
  playback: {
    queueBusy: boolean;
    state: AssistantState;
    turnRevision: number | null;
    trigger: "user" | "scheduled" | "jev" | null;
    fixedReply: boolean;
    currentText: string;
    turnStartedAt: string | null;
    currentTextStartedAt: string | null;
    currentTextElapsedMs: number | null;
  };
  recentBackchannel: { text: string; spokenAt: string } | null;
  backchannelCooldownRemainingMs: number;
  backchannelPhrases: string[];
  hotkeys: VTubeHotkey[];
  timing: ConversationTiming;
};

export type JevActionResponse = {
  revision: number;
  kind: "action";
  action: JevAction;
  backchannelText: string | null;
  hotkeyID: string | null;
  diagnostics?: Record<string, unknown>;
};


export type JevFloorResponse = {
  revision: number;
  kind: "floor";
  floorControl: FloorControl;
  diagnostics?: Record<string, unknown>;
};

export type JevResponse = JevActionResponse | JevFloorResponse;


export type TurnEvent =
  | { type: "text.delta"; delta: string }
  | {
      type: "audio.ready";
      sentenceIndex: number;
      text: string;
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

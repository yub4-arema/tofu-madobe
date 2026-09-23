import type {
  AssistantState,
  ConversationMode,
  JevAction,
  JevEvaluationReason,
  JevRequest,
  ScheduledSpeechState,
} from "./protocol";

export type BufferedTranscript = {
  text: string;
  revision: number;
  startedAt: number;
  committedAt: number;
  overlappedAssistant: boolean;
  overlapResolved: boolean;
};

export type Settings = {
  mode: ConversationMode;
  scheduledEnabled: boolean;
  minSeconds: number;
  maxSeconds: number;
  ttsProvider: "utau" | "voicevox";
  voicevoxSpeaker: number;
  system: string;
  soloPrompt: string;
  interruptPhrases: string;
  backchannelPhrases: string;
};

export const defaultSettings: Settings = {
  mode: "normal",
  scheduledEnabled: true,
  minSeconds: 180,
  maxSeconds: 420,
  ttsProvider: "utau",
  voicevoxSpeaker: 3,
  system: "",
  soloPrompt:
    "直近の話題と重複しない、聞いて楽しめる短い話題を一つ自然に話してください。待機や自動発言には触れないでください。",
  interruptPhrases: [
    "ちょっと待って。",
    "あ、えっと。",
    "あの、ひとついい？",
    "ごめん、少しだけ。",
    "そうだ、ちょっといい？",
    "そこ、少し気になった。",
  ].join("\n"),
  backchannelPhrases: [
    "うん。",
    "あー。",
    "なるほど。",
    "たしかに。",
    "そうなんだ。",
    "へえ。",
  ].join("\n"),
};

export function normalizePhrases(value: string, limit = 12) {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((phrase) => phrase.trim())
        .filter(Boolean),
    ),
  ]
    .map((phrase) => Array.from(phrase).slice(0, 40).join(""))
    .slice(0, limit);
}

function seconds(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1800, Math.max(5, Math.round(value)))
    : fallback;
}

export function migrateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") return defaultSettings;
  const saved = value as Record<string, unknown>;
  const legacyMode = saved.mode;
  const mode: ConversationMode =
    legacyMode === "natural" || legacyMode === "auto" ? "natural" : "normal";
  const scheduledEnabled =
    typeof saved.scheduledEnabled === "boolean"
      ? saved.scheduledEnabled
      : legacyMode === "scheduled";
  const minSeconds = seconds(saved.minSeconds, defaultSettings.minSeconds);
  return {
    mode,
    scheduledEnabled,
    minSeconds,
    maxSeconds: Math.max(minSeconds, seconds(saved.maxSeconds, defaultSettings.maxSeconds)),
    ttsProvider: saved.ttsProvider === "voicevox" ? "voicevox" : "utau",
    voicevoxSpeaker:
      typeof saved.voicevoxSpeaker === "number" &&
      Number.isInteger(saved.voicevoxSpeaker) &&
      saved.voicevoxSpeaker >= 0
        ? saved.voicevoxSpeaker
        : defaultSettings.voicevoxSpeaker,
    system: typeof saved.system === "string" ? saved.system : defaultSettings.system,
    soloPrompt:
      typeof saved.soloPrompt === "string" ? saved.soloPrompt : defaultSettings.soloPrompt,
    interruptPhrases:
      typeof saved.interruptPhrases === "string"
        ? saved.interruptPhrases
        : defaultSettings.interruptPhrases,
    backchannelPhrases:
      typeof saved.backchannelPhrases === "string"
        ? saved.backchannelPhrases
        : defaultSettings.backchannelPhrases,
  };
}

export function scheduledFollowUp(
  mode: ConversationMode,
  hasConfirmed: boolean,
  hasPartial: boolean,
) {
  if (!hasConfirmed && !hasPartial) return "none" as const;
  return mode === "normal" ? (hasConfirmed ? "normal" : "await-commit") : "natural";
}

export function shouldApplyJevResponse(
  responseRevision: number,
  requestRevision: number,
  _snapshotTranscriptRevision?: number,
  _currentTranscriptRevision?: number,
) {
  return responseRevision === requestRevision;
}

export function shouldEvaluateJev(
  running: boolean,
  mode: ConversationMode,
  assistantState: AssistantState,
  scheduledSpeech: ScheduledSpeechState,
  reason: JevEvaluationReason,
) {
  return (
    running &&
    mode === "natural" &&
    scheduledSpeech === "idle" &&
    reason === "clock_tick" &&
    (assistantState === "idle" || assistantState === "generating" || assistantState === "speaking")
  );
}

export function canPlayBackchannel(lastPlayedAt: number | null, now: number) {
  return lastPlayedAt === null || now - lastPlayedAt >= 3000;
}

export function canApplyJevAction(action: JevAction, isBusy: boolean) {
  return action === "wait" || action === "interrupt" || !isBusy;
}

export function allowsTextlessJevTurn(action: JevAction, reason: JevEvaluationReason | undefined) {
  return action === "topic" || (action === "respond" && reason === "clock_tick");
}

export function unhandledPartial(partial: string, handledPrefix: string) {
  if (!handledPrefix) return partial;
  if (partial.startsWith(handledPrefix)) return partial.slice(handledPrefix.length).trim();
  return partial === handledPrefix ? "" : partial;
}

export function transcriptSnapshot(
  confirmed: BufferedTranscript[],
  partial: string,
  partialStartedAt: number | null,
  partialUpdatedAt: number | null,
  partialOverlappedAssistant: boolean,
  partialOverlapResolved: boolean,
  now: number,
): JevRequest["transcriptState"] {
  return {
    partial: {
      text: partial,
      startedAt: partialStartedAt === null ? null : new Date(partialStartedAt).toISOString(),
      updatedAt: partialUpdatedAt === null ? null : new Date(partialUpdatedAt).toISOString(),
      activeForSeconds:
        partialStartedAt === null ? null : Math.max(0, now - partialStartedAt) / 1000,
      unchangedForSeconds:
        partialUpdatedAt === null ? null : Math.max(0, now - partialUpdatedAt) / 1000,
      overlappedAssistant: partialOverlappedAssistant,
      overlapResolved: partialOverlapResolved,
    },
    confirmed: confirmed.map(
      ({ text, revision, startedAt, committedAt, overlappedAssistant, overlapResolved }) => ({
        text,
        revision,
        startedAt: new Date(startedAt).toISOString(),
        committedAt: new Date(committedAt).toISOString(),
        speechDurationSeconds: Math.max(0, committedAt - startedAt) / 1000,
        committedAgoSeconds: Math.max(0, now - committedAt) / 1000,
        overlappedAssistant,
        overlapResolved,
      }),
    ),
    hasUncommittedSpeech: !!partial,
  };
}

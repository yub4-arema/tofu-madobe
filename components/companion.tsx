"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MicIcon,
  PanelTopOpenIcon,
  PlayIcon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
} from "lucide-react";
import { useAudioQueue } from "@/hooks/use-audio-queue";
import { useScribe } from "@/hooks/use-scribe";
import { debugError, debugLog, debugWarn, type DebugDetails } from "@/lib/debug-log";
import {
  canApplyJevAction,
  canPlayBackchannel,
  type BufferedTranscript,
  defaultSettings,
  migrateSettings,
  normalizePhrases,
  scheduledFollowUp,
  shouldApplyJevResponse,
  shouldEvaluateJev,
  type Settings,
  transcriptSnapshot,
  unhandledPartial,
} from "@/lib/conversation-state";
import {
  isTurnEvent,
  type AssistantState,
  type ChatHistoryMessage,
  type ConversationTiming,
  type JevAction,
  type JevEvaluationReason,
  type JevRequest,
  type JevResponse,
  type ScheduledSpeechState,
  type VTubeHotkey,
} from "@/lib/protocol";
import { triggerVTubeHotkey, watchVTubeStudio } from "@/lib/vtube-studio";

type TurnTrigger = "user" | "scheduled" | "jev";
type TurnResult = "done" | "failed" | "cancelled";
type TurnOptions = {
  trigger: TurnTrigger;
  text?: string;
  jevAction?: JevAction;
  jevReason?: JevEvaluationReason;
  recordUser?: boolean;
  recordAssistant?: boolean;
  interruptCue?: string;
  fixedReply?: string;
  hotkey?: VTubeHotkey;
};

type ActiveTurn = {
  revision: number;
  trigger: TurnTrigger;
  jevAction: JevAction | null;
  fixedReply: boolean;
  startedAt: string;
  playingStartedAt: string | null;
  playingText: string;
  playedSentences: string[];
};

type RecentBackchannel = { text: string; spokenAt: string };
type InterruptedAssistant = {
  spokenText: string;
  activeText: string;
  interruptedAt: string;
};

type ConversationChoice = "normal" | "scheduled" | "natural";

function status(
  running: boolean,
  micEnabled: boolean,
  scribeStatus: "stopped" | "connecting" | "connected",
  assistant: AssistantState,
  scheduled: ScheduledSpeechState,
  partial: string,
) {
  if (!running) return "停止中";
  if (scheduled === "generating") return "定期発話を生成中";
  if (scheduled === "speaking") return "定期発話中";
  if (assistant === "generating") return "返答を生成中";
  if (assistant === "speaking") return "発話中";
  if (!micEnabled) return "マイク停止中";
  if (scribeStatus !== "connected") return "Scribeへ接続中";
  return partial ? "発話を認識中" : "待機中";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function readStream(response: Response, scope: string, onEvent: (value: unknown) => void) {
  if (!response.body) throw new Error("応答ストリームがありません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let chunkIndex = 0;
  let eventIndex = 0;
  debugLog(scope, "SSE reader started");
  while (true) {
    const { value, done } = await reader.read();
    chunkIndex += 1;
    debugLog(scope, "SSE chunk received", {
      chunkIndex,
      bytes: value?.byteLength ?? 0,
      done,
      pendingCharactersBefore: pending.length,
    });
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      eventIndex += 1;
      try {
        onEvent(JSON.parse(line));
      } catch (error) {
        debugError(scope, "SSE event parse/apply failed", error, {
          eventIndex,
          line,
        });
        throw error;
      }
    }
    if (done) break;
  }
  if (pending.trim()) {
    eventIndex += 1;
    try {
      onEvent(JSON.parse(pending));
    } catch (error) {
      debugError(scope, "final SSE event parse/apply failed", error, {
        eventIndex,
        line: pending,
      });
      throw error;
    }
  }
  debugLog(scope, "SSE reader completed", { chunkCount: chunkIndex, eventCount: eventIndex });
}

export function Companion() {
  const {
    enqueue,
    waitForIdle,
    stop: stopAudio,
    busy: audioBusy,
    playingText,
    error: audioError,
    clearError: clearAudioError,
  } = useAudioQueue();
  const [settings, setSettings] = useState(defaultSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [compact, setCompact] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantState, setAssistantStateValue] = useState<AssistantState>("idle");
  const [scheduledSpeech, setScheduledSpeechValue] = useState<ScheduledSpeechState>("idle");
  const [scheduledDue, setScheduledDue] = useState(false);
  const [scheduleCycle, setScheduleCycle] = useState(0);
  const [partial, setPartial] = useState("");
  const [confirmed, setConfirmed] = useState<BufferedTranscript[]>([]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [vtubeConnected, setVtubeConnected] = useState(false);
  const [hotkeys, setHotkeys] = useState<VTubeHotkey[]>([]);

  const settingsRef = useRef(settings);
  const runningRef = useRef(false);
  const assistantStateRef = useRef<AssistantState>("idle");
  const scheduledSpeechRef = useRef<ScheduledSpeechState>("idle");
  const scheduledDueRef = useRef(false);
  const partialRef = useRef("");
  const confirmedRef = useRef<BufferedTranscript[]>([]);
  const historyRef = useRef<ChatHistoryMessage[]>([]);
  const hotkeysRef = useRef<VTubeHotkey[]>([]);
  const handledPartialRef = useRef("");
  const autoAfterScheduledCommitRef = useRef(false);
  const conversationStartedAtRef = useRef<number | null>(null);
  const partialStartedAtRef = useRef<number | null>(null);
  const partialUpdatedAtRef = useRef<number | null>(null);
  const lastUserActivityAtRef = useRef<number | null>(null);
  const lastCommitAtRef = useRef<number | null>(null);
  const assistantStateChangedAtRef = useRef(Date.now());
  const lastAssistantSpeechEndedAtRef = useRef<number | null>(null);
  const stateRevisionRef = useRef(0);
  const transcriptRevisionRef = useRef(0);
  const turnRevisionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const activeTurnRef = useRef<ActiveTurn | null>(null);
  const partialOverlappedAssistantRef = useRef(false);
  const partialOverlapResolvedRef = useRef(false);
  const lastBackchannelAtRef = useRef<number | null>(null);
  const recentBackchannelRef = useRef<RecentBackchannel | null>(null);
  const interruptedAssistantRef = useRef<InterruptedAssistant | null>(null);
  const jevInFlightRef = useRef(false);
  const jevRequestRevisionRef = useRef(0);
  const startTurnRef = useRef<(options: TurnOptions) => Promise<TurnResult>>(
    async () => "cancelled",
  );
  const sendConfirmedRef = useRef<() => void>(() => undefined);
  const evaluateJevRef = useRef<(reason: JevEvaluationReason) => void>(() => undefined);
  const maybeRunScheduledRef = useRef<() => void>(() => undefined);
  const turnSettledRef = useRef<(trigger: TurnTrigger) => void>(() => undefined);

  const changed = useCallback((reason = "unspecified", details: DebugDetails = {}) => {
    const previousStateRevision = stateRevisionRef.current;
    stateRevisionRef.current += 1;
    debugLog("companion:state", "revision changed", {
      previousStateRevision,
      currentStateRevision: stateRevisionRef.current,
      reason,
      ...details,
    });
  }, []);

  const timingSnapshot = useCallback((now = Date.now()): ConversationTiming => {
    const elapsed = (timestamp: number | null) => (timestamp === null ? null : now - timestamp);
    return {
      now: new Date(now).toISOString(),
      conversationStartedAt:
        conversationStartedAtRef.current === null
          ? null
          : new Date(conversationStartedAtRef.current).toISOString(),
      conversationElapsedMs: elapsed(conversationStartedAtRef.current),
      currentPartialElapsedMs: partialRef.current ? elapsed(partialStartedAtRef.current) : null,
      sinceLastUserActivityMs: elapsed(lastUserActivityAtRef.current),
      sinceLastCommitMs: elapsed(lastCommitAtRef.current),
      assistantStateElapsedMs: now - assistantStateChangedAtRef.current,
      sinceAssistantSpeechEndedMs: elapsed(lastAssistantSpeechEndedAtRef.current),
    };
  }, []);

  const replaceConfirmed = useCallback(
    (segments: BufferedTranscript[]) => {
      confirmedRef.current = segments;
      setConfirmed(segments);
      changed("confirmed replaced", { count: segments.length, segments });
    },
    [changed],
  );

  const replaceHistory = useCallback(
    (messages: ChatHistoryMessage[]) => {
      const next = messages.slice(-16);
      historyRef.current = next;
      changed("history replaced", {
        count: next.length,
        messages: next.map(({ role, content }) => ({ role, content })),
      });
    },
    [changed],
  );

  const setAssistantState = useCallback(
    (value: AssistantState) => {
      const previous = assistantStateRef.current;
      if (previous === value) {
        debugLog("companion:state", "assistant state unchanged", { value });
        return;
      }
      const now = Date.now();
      assistantStateRef.current = value;
      assistantStateChangedAtRef.current = now;
      if (previous === "speaking" && value === "idle") lastAssistantSpeechEndedAtRef.current = now;
      setAssistantStateValue(value);
      changed("assistant state changed", { previous, current: value });
    },
    [changed],
  );

  const setScheduledSpeech = useCallback(
    (value: ScheduledSpeechState) => {
      const previous = scheduledSpeechRef.current;
      if (previous === value) {
        debugLog("companion:state", "scheduled speech state unchanged", { value });
        return;
      }
      scheduledSpeechRef.current = value;
      setScheduledSpeechValue(value);
      changed("scheduled speech state changed", { previous, current: value });
    },
    [changed],
  );

  const onPartial = useCallback(
    (text: string) => {
      const previous = partialRef.current;
      const now = Date.now();
      const updated = text !== previous;
      if (!partialRef.current && text) {
        handledPartialRef.current = "";
        partialStartedAtRef.current = now;
        partialOverlapResolvedRef.current = false;
        const activeTurn = activeTurnRef.current;
        partialOverlappedAssistantRef.current =
          settingsRef.current.mode === "natural" &&
          scheduledSpeechRef.current === "idle" &&
          assistantStateRef.current === "speaking" &&
          !!activeTurn &&
          activeTurn.trigger !== "scheduled" &&
          !activeTurn.fixedReply;
      }
      const activeTurn = activeTurnRef.current;
      if (
        text &&
        updated &&
        settingsRef.current.mode === "natural" &&
        scheduledSpeechRef.current === "idle" &&
        assistantStateRef.current === "speaking" &&
        !!activeTurn &&
        activeTurn?.trigger !== "scheduled" &&
        !activeTurn?.fixedReply
      )
        partialOverlappedAssistantRef.current = true;
      if (text && updated) partialUpdatedAtRef.current = now;
      if (text) lastUserActivityAtRef.current = now;
      partialRef.current = text;
      setPartial(text);
      if (!updated) {
        debugLog("companion:scribe", "duplicate partial ignored for Jev", { text });
        return;
      }
      transcriptRevisionRef.current += 1;
      changed("Scribe partial received", {
        previous,
        text,
        transcriptRevision: transcriptRevisionRef.current,
        overlappedAssistant: partialOverlappedAssistantRef.current,
        handledPartial: handledPartialRef.current,
      });
      debugLog("companion:jev", "partial retained for next one-second Jev tick", {
        transcriptRevision: transcriptRevisionRef.current,
        partialLength: text.length,
      });
    },
    [changed],
  );

  const onCommitted = useCallback(
    (text: string) => {
      const previousPartial = partialRef.current;
      const now = Date.now();
      const startedAt = partialStartedAtRef.current ?? now;
      const overlappedAssistant = partialOverlappedAssistantRef.current;
      const overlapResolved = partialOverlapResolvedRef.current;
      partialRef.current = "";
      partialStartedAtRef.current = null;
      partialUpdatedAtRef.current = null;
      partialOverlappedAssistantRef.current = false;
      partialOverlapResolvedRef.current = false;
      if (text) {
        lastUserActivityAtRef.current = now;
        lastCommitAtRef.current = now;
        transcriptRevisionRef.current += 1;
      }
      setPartial("");
      const handledPartial = handledPartialRef.current;
      const remainingText = unhandledPartial(text, handledPartial);
      handledPartialRef.current = "";
      if (remainingText)
        replaceConfirmed([
          ...confirmedRef.current,
          {
            text: remainingText,
            revision: transcriptRevisionRef.current,
            startedAt,
            committedAt: now,
            overlappedAssistant,
            overlapResolved,
          },
        ]);
      else
        changed("Scribe commit did not append", {
          text,
          previousPartial,
          handledPartial,
        });
      debugLog("companion:scribe", "commit applied", {
        text,
        remainingText,
        previousPartial,
        handledPartial,
        confirmedCount: confirmedRef.current.length,
        transcriptRevision: transcriptRevisionRef.current,
        overlappedAssistant,
        autoAfterScheduledCommit: autoAfterScheduledCommitRef.current,
      });
      debugLog("companion:jev", "commit retained for next one-second Jev tick", {
        transcriptRevision: transcriptRevisionRef.current,
        confirmedCount: confirmedRef.current.length,
      });
      if (
        text &&
        autoAfterScheduledCommitRef.current &&
        scheduledSpeechRef.current === "idle" &&
        settingsRef.current.mode === "normal" &&
        assistantStateRef.current === "idle"
      ) {
        autoAfterScheduledCommitRef.current = false;
        debugLog("companion:schedule", "committed input queued after scheduled speech");
        queueMicrotask(() => sendConfirmedRef.current());
      }
    },
    [changed, replaceConfirmed],
  );

  const scribe = useScribe({ onPartial, onCommitted });

  useEffect(() => {
    try {
      const saved = localStorage.getItem("tofu-madobe:settings");
      const next = saved ? migrateSettings(JSON.parse(saved)) : defaultSettings;
      debugLog("companion:settings", "settings loaded", { saved: !!saved, settings: next });
      setSettings(next);
    } catch (error) {
      debugError("companion:settings", "settings load failed; defaults restored", error);
      setSettings(defaultSettings);
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    changed("settings changed", { settings, settingsLoaded });
    if (settingsLoaded) localStorage.setItem("tofu-madobe:settings", JSON.stringify(settings));
    if (!settings.scheduledEnabled) {
      scheduledDueRef.current = false;
      setScheduledDue(false);
      debugLog("companion:schedule", "scheduled speech disabled; pending due cleared");
    }
  }, [changed, settings, settingsLoaded]);

  const startTurn = useCallback(
    async (options: TurnOptions): Promise<TurnResult> => {
      debugLog("companion:turn", "start requested", {
        options,
        running: runningRef.current,
        assistantState: assistantStateRef.current,
        scheduledSpeech: scheduledSpeechRef.current,
        turnRevision: turnRevisionRef.current,
      });
      if (
        !runningRef.current ||
        assistantStateRef.current !== "idle" ||
        scheduledSpeechRef.current !== "idle"
      ) {
        debugWarn("companion:turn", "start rejected by state guard", {
          options,
          running: runningRef.current,
          assistantState: assistantStateRef.current,
          scheduledSpeech: scheduledSpeechRef.current,
        });
        return "cancelled";
      }
      const isScheduled = options.trigger === "scheduled";
      const revision = ++turnRevisionRef.current;
      const requestId = crypto.randomUUID();
      const scope = `companion:turn:${requestId}`;
      const startedAt = performance.now();
      const controller = new AbortController();
      abortRef.current = controller;
      const activeTurn: ActiveTurn = {
        revision,
        trigger: options.trigger,
        jevAction: options.jevAction ?? null,
        fixedReply: !!options.fixedReply,
        startedAt: new Date().toISOString(),
        playingStartedAt: null,
        playingText: "",
        playedSentences: [],
      };
      activeTurnRef.current = activeTurn;
      debugLog(scope, "turn accepted", { revision, options });
      setError(null);
      clearAudioError();
      setReply("");
      setAssistantState("generating");
      if (isScheduled) setScheduledSpeech("generating");
      let completedText = "";
      try {
        const timing = timingSnapshot();
        const recentBackchannel = options.fixedReply ? undefined : recentBackchannelRef.current;
        const interruptedAssistant = options.fixedReply
          ? undefined
          : interruptedAssistantRef.current;
        const includeSoloPrompt =
          isScheduled ||
          options.jevAction === "topic" ||
          (options.jevAction === "respond" && !options.text);
        const soloPrompt = includeSoloPrompt ? settingsRef.current.soloPrompt : undefined;
        debugLog(scope, "POST /api/turn/stream", {
          revision,
          trigger: options.trigger,
          jevAction: options.jevAction,
          jevReason: options.jevReason,
          text: options.text,
          historyCount: historyRef.current.length,
          systemPrompt:
            settingsRef.current.system || "(empty: server OPENAI_SYSTEM_PROMPT is used)",
          soloPrompt,
          interruptCue: options.interruptCue,
          fixedReply: options.fixedReply,
          hotkey: options.hotkey,
          recentBackchannel,
          interruptedAssistant,
          timing,
        });
        const response = await fetch("/api/turn/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId,
            trigger: options.trigger,
            text: options.text,
            jevAction: options.jevAction,
            jevReason: options.jevReason,
            history: historyRef.current,
            system: settingsRef.current.system,
            soloPrompt,
            interruptCue: options.interruptCue,
            fixedReply: options.fixedReply,
            hotkey: options.hotkey,
            recentBackchannel,
            interruptedAssistant,
            timing,
          }),
          signal: controller.signal,
        });
        debugLog(scope, "turn response headers received", {
          status: response.status,
          ok: response.ok,
          contentType: response.headers.get("content-type"),
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (!response.ok)
          throw new Error(
            ((await response.json().catch(() => null)) as { error?: { message?: string } } | null)
              ?.error?.message ?? "返答の生成に失敗しました。",
          );
        await readStream(response, scope, (value) => {
          if (revision !== turnRevisionRef.current) {
            debugWarn(scope, "SSE event discarded: stale turn revision", {
              event: value,
              responseRevision: revision,
              currentRevision: turnRevisionRef.current,
            });
            return;
          }
          if (!isTurnEvent(value)) {
            debugWarn(scope, "SSE event discarded: invalid event", { value });
            return;
          }
          debugLog(scope, "SSE event accepted", { event: value });
          if (value.type === "text.delta") setReply((current) => current + value.delta);
          if (value.type === "audio.ready") {
            setAssistantState("speaking");
            if (isScheduled) setScheduledSpeech("speaking");
            enqueue({
              ...value,
              audioUrl: new URL(value.audioUrl, location.origin).toString(),
              onStarted: () => {
                if (activeTurnRef.current?.revision !== revision) return;
                activeTurnRef.current.playingText = value.text;
                activeTurnRef.current.playingStartedAt = new Date().toISOString();
                debugLog(scope, "sentence playback started", {
                  sentenceIndex: value.sentenceIndex,
                  text: value.text,
                  fixedReply: activeTurnRef.current.fixedReply,
                  playingStartedAt: activeTurnRef.current.playingStartedAt,
                });
              },
              onCompleted: () => {
                if (activeTurnRef.current?.revision !== revision) return;
                activeTurnRef.current.playedSentences.push(value.text);
                activeTurnRef.current.playingText = "";
                activeTurnRef.current.playingStartedAt = null;
                debugLog(scope, "sentence playback completed", {
                  sentenceIndex: value.sentenceIndex,
                  text: value.text,
                  playedSentences: activeTurnRef.current.playedSentences,
                });
              },
            });
          }
          if (value.type === "turn.completed") {
            completedText = value.text;
            setReply(value.text);
          }
          if (value.type === "turn.error") throw new Error(value.error.message);
        });
        debugLog(scope, "SSE completed; waiting for audio queue", {
          revision,
          currentRevision: turnRevisionRef.current,
        });
        await waitForIdle();
        debugLog(scope, "audio queue became idle", {
          revision,
          currentRevision: turnRevisionRef.current,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (revision !== turnRevisionRef.current) {
          debugWarn(scope, "turn cancelled after audio wait: stale revision", {
            revision,
            currentRevision: turnRevisionRef.current,
          });
          return "cancelled";
        }
        if (completedText && (options.recordUser || options.recordAssistant !== false)) {
          const additions: ChatHistoryMessage[] = [];
          if (options.recordUser && options.text)
            additions.push({ role: "user", content: options.text });
          if (options.recordAssistant !== false)
            additions.push({ role: "assistant", content: completedText });
          replaceHistory([...historyRef.current, ...additions]);
        }
        if (!options.fixedReply) {
          recentBackchannelRef.current = null;
          interruptedAssistantRef.current = null;
        } else if (completedText) {
          const spokenAt = new Date().toISOString();
          lastBackchannelAtRef.current = Date.now();
          recentBackchannelRef.current = { text: completedText, spokenAt };
          debugLog(scope, "fixed backchannel recorded", { text: completedText, spokenAt });
        }
        debugLog(scope, "turn completed", {
          revision,
          completedText,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        return "done";
      } catch (caught) {
        if (controller.signal.aborted || revision !== turnRevisionRef.current) {
          debugWarn(scope, "turn cancelled in catch", {
            aborted: controller.signal.aborted,
            revision,
            currentRevision: turnRevisionRef.current,
            error: caught instanceof Error ? caught.message : String(caught),
          });
          return "cancelled";
        }
        debugError(scope, "turn failed", caught, {
          revision,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        setError(caught instanceof Error ? caught.message : "返答の生成に失敗しました。");
        return "failed";
      } finally {
        if (revision === turnRevisionRef.current) {
          debugLog(scope, "turn finalizing current revision", { revision });
          abortRef.current = null;
          activeTurnRef.current = null;
          setAssistantState("idle");
          if (isScheduled) setScheduledSpeech("idle");
          turnSettledRef.current(options.trigger);
        } else {
          debugWarn(scope, "turn finalizer skipped: revision superseded", {
            revision,
            currentRevision: turnRevisionRef.current,
          });
        }
      }
    },
    [
      clearAudioError,
      enqueue,
      replaceHistory,
      setAssistantState,
      setScheduledSpeech,
      timingSnapshot,
      waitForIdle,
    ],
  );
  startTurnRef.current = startTurn;

  const sendConfirmed = useCallback(() => {
    if (
      !runningRef.current ||
      assistantStateRef.current !== "idle" ||
      scheduledSpeechRef.current !== "idle"
    ) {
      debugWarn("companion:turn", "confirmed send rejected by state guard", {
        running: runningRef.current,
        assistantState: assistantStateRef.current,
        scheduledSpeech: scheduledSpeechRef.current,
        confirmed: confirmedRef.current,
      });
      return;
    }
    const segments = confirmedRef.current;
    const text = segments
      .map(({ text }) => text)
      .join("\n")
      .trim();
    if (!text) {
      debugWarn("companion:turn", "confirmed send rejected: empty transcript");
      return setError("送信できる確定済み文字起こしがまだありません。");
    }
    debugLog("companion:turn", "confirmed transcript consumed for turn", { segments, text });
    replaceConfirmed([]);
    void startTurnRef.current({ trigger: "user", text, recordUser: true }).then((result) => {
      if (result === "failed") replaceConfirmed([...segments, ...confirmedRef.current]);
    });
  }, [replaceConfirmed]);
  sendConfirmedRef.current = sendConfirmed;

  const yieldToUser = useCallback(() => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn || activeTurn.trigger === "scheduled" || activeTurn.fixedReply) {
      debugLog("companion:turn", "yield requested without interruptible active turn", {
        activeTurn,
      });
      return;
    }
    const spokenText = activeTurn.playedSentences.join("");
    interruptedAssistantRef.current = {
      spokenText,
      activeText: activeTurn.playingText,
      interruptedAt: new Date().toISOString(),
    };
    if (spokenText)
      replaceHistory([...historyRef.current, { role: "assistant", content: spokenText }]);
    debugWarn("companion:turn", "yielding current turn to user", {
      revision: activeTurn.revision,
      spokenText,
      activeText: activeTurn.playingText,
      transcriptRevision: transcriptRevisionRef.current,
    });
    abortRef.current?.abort();
    abortRef.current = null;
    activeTurnRef.current = null;
    turnRevisionRef.current += 1;
    stopAudio();
    setAssistantState("idle");
    debugLog("companion:jev", "Jev evaluation deferred to one-second clock", {
      transcriptRevision: transcriptRevisionRef.current,
    });
  }, [replaceHistory, setAssistantState, stopAudio]);

  const applyJev = useCallback(
    (result: JevResponse, snapshotTranscriptRevision: number, reason: JevEvaluationReason) => {
      if (result.kind === "floor") {
        debugLog("companion:jev", "applying floor response", {
          result,
          snapshotTranscriptRevision,
          currentTranscriptRevision: transcriptRevisionRef.current,
        });
        if (result.floorControl === "keep_floor") {
          // Jev determined the user is backchannelling or repeating the same unresolved request.
          // Consume all overlapped confirmed so they don't accumulate as pending turns.
          const remaining = confirmedRef.current.filter(
            ({ overlappedAssistant }) => !overlappedAssistant,
          );
          if (remaining.length !== confirmedRef.current.length) {
            debugLog("companion:jev", "overlapped confirmed consumed as user backchannel", {
              removed: confirmedRef.current.length - remaining.length,
              remaining: remaining.length,
            });
            replaceConfirmed(remaining);
          }
          // Mark overlapping partial as resolved so it won't re-trigger floor on the next tick.
          if (partialOverlappedAssistantRef.current) {
            partialOverlapResolvedRef.current = true;
          }
          return;
        }
        // yield_floor: Jev determined the user wants the floor.
        // Leave confirmed intact so the next action tick can respond to the user's speech.
        yieldToUser();
        return;
      }

      const currentPartial = unhandledPartial(partialRef.current, handledPartialRef.current);
      const currentText = [...confirmedRef.current.map(({ text }) => text), currentPartial]
        .filter(Boolean)
        .join("\n");
      const isBusy = assistantStateRef.current !== "idle";
      const executable = canApplyJevAction(result.action, isBusy);
      debugLog("companion:jev", "action application started", {
        result,
        reason,
        currentText,
        isBusy,
        assistantState: assistantStateRef.current,
        confirmed: confirmedRef.current,
        partial: partialRef.current,
        currentPartial,
        handledPartial: handledPartialRef.current,
        executable,
      });
      if (!executable) {
        debugWarn("companion:jev", "action blocked by runtime state", {
          result,
          reason,
          isBusy,
          assistantState: assistantStateRef.current,
        });
        return;
      }
      if (activeTurnRef.current?.fixedReply) {
        debugLog("companion:jev", "action ignored while fixed backchannel is playing", {
          result,
          activeTurn: activeTurnRef.current,
          assistantState: assistantStateRef.current,
          audioBusy,
        });
        return;
      }
      if (result.action === "interrupt" && isBusy) {
        debugWarn("companion:jev", "Jev interrupt is stopping the active turn", {
          result,
          activeTurn: activeTurnRef.current,
        });
        yieldToUser();
      }
      if (result.action === "backchannel") {
        const now = Date.now();
        if (!result.backchannelText) {
          debugWarn("companion:jev", "backchannel discarded: fixed text is missing", { result });
          return;
        }
        if (!canPlayBackchannel(lastBackchannelAtRef.current, now)) {
          debugLog("companion:jev", "backchannel suppressed by cooldown", {
            result,
            lastBackchannelAt: lastBackchannelAtRef.current,
            cooldownRemainingMs: 3000 - (now - (lastBackchannelAtRef.current ?? 0)),
          });
          return;
        }
      }
      const selectedHotkey = result.hotkeyID
        ? hotkeysRef.current.find(({ id }) => id === result.hotkeyID)
        : undefined;
      if (selectedHotkey) {
        debugLog("companion:jev", "triggering VTube Studio hotkey", {
          revision: result.revision,
          hotkey: selectedHotkey,
        });
        void triggerVTubeHotkey(selectedHotkey.id)
          .then(() =>
            debugLog("companion:jev", "VTube Studio hotkey completed", {
              revision: result.revision,
              hotkey: selectedHotkey,
            }),
          )
          .catch((caught: unknown) => {
            debugError("companion:jev", "VTube Studio hotkey failed", caught, {
              revision: result.revision,
              hotkey: selectedHotkey,
            });
            setError(caught instanceof Error ? caught.message : "ホットキーを実行できません。");
          });
      } else if (result.hotkeyID) {
        debugWarn("companion:jev", "hotkey discarded: ID is not in current cache", {
          revision: result.revision,
          hotkeyID: result.hotkeyID,
          cachedIDs: hotkeysRef.current.map(({ id }) => id),
        });
      }
      debugLog("companion:jev", "action committed", {
        result,
        reason,
        snapshotTranscriptRevision,
      });
      if (result.action === "wait") {
        debugLog("companion:jev", "non-speaking action completed", { result });
        return;
      }
      const consumesInput =
        !!currentText && (result.action === "respond" || result.action === "interrupt");
      const consumed = consumesInput ? confirmedRef.current : [];
      const previousHandledPartial = handledPartialRef.current;
      const consumedPartial = consumesInput ? partialRef.current : "";
      if (consumesInput) {
        replaceConfirmed([]);
        if (consumedPartial) handledPartialRef.current = consumedPartial;
      }
      const interruptPhrases = normalizePhrases(settingsRef.current.interruptPhrases);
      const interruptCue =
        result.action === "interrupt" && interruptPhrases.length
          ? interruptPhrases[Math.floor(Math.random() * interruptPhrases.length)]
          : undefined;
      debugLog("companion:jev", "starting turn for accepted action", {
        result,
        currentText,
        consumesInput,
        consumedPartial,
        consumed,
        interruptCue,
        selectedHotkey,
      });
      void startTurnRef
        .current({
          trigger: "jev",
          text: result.action === "topic" ? undefined : currentText || undefined,
          jevAction: result.action,
          jevReason: reason,
          recordUser: consumesInput,
          recordAssistant: result.action !== "backchannel",
          interruptCue,
          fixedReply:
            result.action === "backchannel" ? (result.backchannelText ?? undefined) : undefined,
          hotkey: selectedHotkey,
        })
        .then((turnResult) => {
          debugLog("companion:jev", "action turn settled", {
            revision: result.revision,
            action: result.action,
            turnResult,
          });
          if (turnResult !== "failed" || !consumesInput) return;
          replaceConfirmed([...consumed, ...confirmedRef.current]);
          if (consumedPartial) handledPartialRef.current = previousHandledPartial;
        });
    },
    [audioBusy, replaceConfirmed, yieldToUser],
  );

  const evaluateJev = useCallback(
    async (reason: JevEvaluationReason) => {
      if (
        !shouldEvaluateJev(
          runningRef.current,
          settingsRef.current.mode,
          assistantStateRef.current,
          scheduledSpeechRef.current,
          reason,
        )
      ) {
        debugLog("companion:jev", "evaluation skipped by mode/state guard", {
          running: runningRef.current,
          mode: settingsRef.current.mode,
          assistantState: assistantStateRef.current,
          scheduledSpeech: scheduledSpeechRef.current,
          reason,
        });
        return;
      }
      if (jevInFlightRef.current) {
        debugLog("companion:jev", "one-second evaluation skipped while request is in flight", {
          latestRequestedRevision: jevRequestRevisionRef.current,
          transcriptRevision: transcriptRevisionRef.current,
        });
        return;
      }
      jevInFlightRef.current = true;
      const revision = ++jevRequestRevisionRef.current;
      const snapshotTranscriptRevision = transcriptRevisionRef.current;
      const currentPartial = unhandledPartial(partialRef.current, handledPartialRef.current);
      const hasPendingUserInput = !!currentPartial || confirmedRef.current.length > 0;
      if (assistantStateRef.current === "generating" && !hasPendingUserInput) {
        debugLog("companion:jev", "clock tick skipped while LLM is generating without user input", {
          transcriptRevision: snapshotTranscriptRevision,
          assistantState: assistantStateRef.current,
          activeTurn: activeTurnRef.current,
        });
        jevInFlightRef.current = false;
        return;
      }
      const now = Date.now();
      const currentActiveTurn = activeTurnRef.current;
      const body: JevRequest = {
        revision,
        transcriptRevision: snapshotTranscriptRevision,
        reason,
        transcriptState: transcriptSnapshot(
          confirmedRef.current,
          currentPartial,
          partialStartedAtRef.current,
          partialUpdatedAtRef.current,
          partialOverlappedAssistantRef.current,
          partialOverlapResolvedRef.current,
          now,
        ),
        history: historyRef.current,
        assistantState: assistantStateRef.current,
        scheduledSpeech: scheduledSpeechRef.current,
        activeTurn:
          currentActiveTurn && currentActiveTurn.trigger !== "scheduled"
            ? {
                trigger: currentActiveTurn.trigger,
                jevAction: currentActiveTurn.jevAction,
                playingText: currentActiveTurn.playingText,
                startedAt: currentActiveTurn.startedAt,
                playingStartedAt: currentActiveTurn.playingStartedAt,
                playingElapsedMs: currentActiveTurn.playingStartedAt
                  ? Math.max(0, now - Date.parse(currentActiveTurn.playingStartedAt))
                  : null,
                playedSentenceCount: currentActiveTurn.playedSentences.length,
                fixedReply: currentActiveTurn.fixedReply,
              }
            : null,
        playback: {
          queueBusy: audioBusy,
          state: assistantStateRef.current,
          turnRevision: currentActiveTurn?.revision ?? null,
          trigger: currentActiveTurn?.trigger ?? null,
          fixedReply: currentActiveTurn?.fixedReply ?? false,
          currentText: currentActiveTurn?.playingText ?? playingText,
          turnStartedAt: currentActiveTurn?.startedAt ?? null,
          currentTextStartedAt: currentActiveTurn?.playingStartedAt ?? null,
          currentTextElapsedMs: currentActiveTurn?.playingStartedAt
            ? Math.max(0, now - Date.parse(currentActiveTurn.playingStartedAt))
            : null,
        },
        recentBackchannel: recentBackchannelRef.current,
        backchannelCooldownRemainingMs: lastBackchannelAtRef.current
          ? Math.max(0, 3000 - (now - lastBackchannelAtRef.current))
          : 0,
        backchannelPhrases: normalizePhrases(settingsRef.current.backchannelPhrases),
        hotkeys: hotkeysRef.current,
        timing: timingSnapshot(now),
      };
      const scope = `companion:jev:${revision}`;
      const startedAt = performance.now();
      debugLog(scope, "request started", { snapshotTranscriptRevision, body });
      try {
        const response = await fetch("/api/jev", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await response.json().catch(() => null)) as
          | (Partial<JevResponse> & { error?: { message?: string } })
          | null;
        debugLog(scope, "response received", {
          status: response.status,
          ok: response.ok,
          data,
          snapshotTranscriptRevision,
          currentTranscriptRevision: transcriptRevisionRef.current,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (!response.ok)
          throw new Error(data?.error?.message ?? "Jevによる行動判断に失敗しました。");
        const hasShape =
          !!data &&
          typeof data.revision === "number" &&
          ((data.kind === "action" && typeof data.action === "string") ||
            (data.kind === "floor" &&
              (data.floorControl === "keep_floor" || data.floorControl === "yield_floor")));
        const revisionAccepted =
          hasShape &&
          shouldApplyJevResponse(
            data.revision as number,
            revision,
            snapshotTranscriptRevision,
            transcriptRevisionRef.current,
          );
        const runtimeAccepted = shouldEvaluateJev(
          runningRef.current,
          settingsRef.current.mode,
          assistantStateRef.current,
          scheduledSpeechRef.current,
          reason,
        );
        if (hasShape && revisionAccepted && runtimeAccepted) {
          debugLog(scope, "response freshness and runtime checks passed", {
            reason,
            snapshotTranscriptRevision,
            diagnostics: data.diagnostics,
          });
          applyJev(data as JevResponse, snapshotTranscriptRevision, reason);
        } else {
          debugWarn(scope, "response discarded before application", {
            hasShape,
            responseRevision: data?.revision,
            requestRevision: revision,
            snapshotTranscriptRevision,
            currentTranscriptRevision: transcriptRevisionRef.current,
            responseRevisionMatches: data?.revision === revision,
            running: runningRef.current,
            mode: settingsRef.current.mode,
            assistantState: assistantStateRef.current,
            scheduledSpeech: scheduledSpeechRef.current,
            reason,
            diagnostics: data?.diagnostics,
          });
        }
      } catch (caught) {
        debugError(scope, "evaluation failed", caught, {
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (runningRef.current && settingsRef.current.mode === "natural")
          setError(caught instanceof Error ? caught.message : "Jevへ接続できません。");
      } finally {
        jevInFlightRef.current = false;
        debugLog(scope, "request settled; next evaluation remains on one-second clock");
      }
    },
    [applyJev, audioBusy, playingText, timingSnapshot],
  );
  evaluateJevRef.current = (reason) => void evaluateJev(reason);

  const maybeRunScheduled = useCallback(() => {
    if (
      !runningRef.current ||
      !settingsRef.current.scheduledEnabled ||
      !scheduledDueRef.current ||
      assistantStateRef.current !== "idle" ||
      scheduledSpeechRef.current !== "idle"
    ) {
      debugLog("companion:schedule", "due speech not started", {
        running: runningRef.current,
        scheduledEnabled: settingsRef.current.scheduledEnabled,
        scheduledDue: scheduledDueRef.current,
        assistantState: assistantStateRef.current,
        scheduledSpeech: scheduledSpeechRef.current,
      });
      return;
    }
    scheduledDueRef.current = false;
    setScheduledDue(false);
    debugLog("companion:schedule", "due speech starting");
    void startTurnRef.current({ trigger: "scheduled" });
  }, []);
  maybeRunScheduledRef.current = maybeRunScheduled;

  turnSettledRef.current = (trigger) => {
    debugLog("companion:turn", "turn settled callback", {
      trigger,
      mode: settingsRef.current.mode,
      confirmed: confirmedRef.current,
      partial: partialRef.current,
      scheduledDue: scheduledDueRef.current,
    });
    if (trigger === "scheduled") {
      setScheduleCycle((value) => value + 1);
      const next = scheduledFollowUp(
        settingsRef.current.mode,
        !!confirmedRef.current.length,
        !!partialRef.current,
      );
      autoAfterScheduledCommitRef.current =
        settingsRef.current.mode === "normal" && !!partialRef.current;
      debugLog("companion:schedule", "scheduled follow-up selected", {
        next,
        autoAfterScheduledCommit: autoAfterScheduledCommitRef.current,
      });
      if (next === "normal") sendConfirmedRef.current();
      return;
    }
    if (
      autoAfterScheduledCommitRef.current &&
      settingsRef.current.mode === "normal" &&
      confirmedRef.current.length
    ) {
      autoAfterScheduledCommitRef.current = false;
      sendConfirmedRef.current();
      return;
    }
    maybeRunScheduledRef.current();
    debugLog("companion:jev", "buffered input will be evaluated on the one-second clock", {
      hasConfirmed: !!confirmedRef.current.length,
      hasPartial: !!unhandledPartial(partialRef.current, handledPartialRef.current),
    });
  };

  useEffect(() => {
    if (!running || settings.mode !== "natural") return;
    debugLog("companion:jev", "one-second evaluation timer started");
    const timer = window.setInterval(() => evaluateJevRef.current("clock_tick"), 1000);
    return () => {
      window.clearInterval(timer);
      debugLog("companion:jev", "one-second evaluation timer stopped");
    };
  }, [running, settings.mode]);

  useEffect(() => {
    if (!running || !settings.scheduledEnabled) return;
    const source = new EventSource(
      `/api/schedule?min=${settings.minSeconds}&max=${settings.maxSeconds}`,
    );
    debugLog("companion:schedule", "timer stream opened", {
      minSeconds: settings.minSeconds,
      maxSeconds: settings.maxSeconds,
      scheduleCycle,
    });
    source.addEventListener("due", () => {
      debugLog("companion:schedule", "timer became due");
      source.close();
      scheduledDueRef.current = true;
      setScheduledDue(true);
      maybeRunScheduledRef.current();
    });
    source.onerror = () => {
      debugWarn("companion:schedule", "timer stream failed");
      source.close();
      setError("定期発話タイマーへ接続できません。");
    };
    return () => {
      source.close();
      debugLog("companion:schedule", "timer stream closed");
    };
  }, [running, scheduleCycle, settings.maxSeconds, settings.minSeconds, settings.scheduledEnabled]);

  useEffect(() => {
    if (!running || settings.mode !== "natural") {
      hotkeysRef.current = [];
      setHotkeys([]);
      setVtubeConnected(false);
      debugLog("companion:vts", "watch disabled", { running, mode: settings.mode });
      return;
    }
    debugLog("companion:vts", "watch enabled");
    return watchVTubeStudio((state) => {
      hotkeysRef.current = state.hotkeys;
      setHotkeys(state.hotkeys);
      setVtubeConnected(state.connected);
      changed("VTube Studio state changed", {
        connected: state.connected,
        hotkeyCount: state.hotkeys.length,
        error: state.error,
      });
      if (state.error) setError(state.error);
    });
  }, [changed, running, settings.mode]);

  const start = async () => {
    debugLog("companion", "start requested", { micEnabled, settings: settingsRef.current });
    runningRef.current = true;
    conversationStartedAtRef.current = Date.now();
    setRunning(true);
    setError(null);
    scribe.clearError();
    await scribe.start();
    debugLog("companion", "start completed", { micEnabled });
  };

  const stop = () => {
    debugWarn("companion", "stop requested", {
      turnRevision: turnRevisionRef.current,
      assistantState: assistantStateRef.current,
      scheduledSpeech: scheduledSpeechRef.current,
    });
    runningRef.current = false;
    setRunning(false);
    scheduledDueRef.current = false;
    setScheduledDue(false);
    autoAfterScheduledCommitRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    turnRevisionRef.current += 1;
    scribe.stop();
    stopAudio();
    setAssistantState("idle");
    setScheduledSpeech("idle");
    partialRef.current = "";
    handledPartialRef.current = "";
    partialStartedAtRef.current = null;
    partialUpdatedAtRef.current = null;
    partialOverlappedAssistantRef.current = false;
    transcriptRevisionRef.current = 0;
    lastBackchannelAtRef.current = null;
    recentBackchannelRef.current = null;
    interruptedAssistantRef.current = null;
    setPartial("");
    replaceConfirmed([]);
    debugLog("companion", "stop completed", { turnRevision: turnRevisionRef.current });
  };

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const conversationChoice: ConversationChoice =
    settings.mode === "natural" ? "natural" : settings.scheduledEnabled ? "scheduled" : "normal";
  const chooseConversation = (choice: ConversationChoice) => {
    debugLog("companion:settings", "conversation choice selected", { choice });
    setSettings((current) => ({
      ...current,
      mode: choice === "natural" ? "natural" : "normal",
      scheduledEnabled: choice === "scheduled",
    }));
  };
  const shownError = error ?? audioError ?? scribe.error;

  return (
    <main className="mx-auto flex min-h-svh max-w-md items-center p-3">
      <section className="w-full rounded-xl border bg-background p-4 shadow-sm">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">tofu-madobe</h1>
            <p className="text-sm text-muted-foreground">
              {status(running, micEnabled, scribe.status, assistantState, scheduledSpeech, partial)}
              {scheduledDue && scheduledSpeech === "idle" ? "・定期発話待ち" : ""}
            </p>
          </div>
          <button
            className="rounded border px-2 py-1 text-sm"
            onClick={() => setCompact((value) => !value)}
          >
            {compact ? "展開" : "折りたたむ"}
          </button>
        </header>
        {!compact && (
          <div className="mt-5 space-y-4">
            <label className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <MicIcon size={18} />
                マイク
              </span>
              <input
                type="checkbox"
                checked={micEnabled}
                disabled={!running}
                onChange={(event) => {
                  setMicEnabled(event.target.checked);
                  scribe.setEnabled(event.target.checked);
                }}
              />
            </label>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">対話方法</legend>
              <div className="flex gap-2">
                {(["normal", "scheduled", "natural"] as ConversationChoice[]).map((choice) => (
                  <label key={choice} className="rounded border px-2 py-1 text-sm">
                    <input
                      className="mr-1"
                      type="radio"
                      checked={conversationChoice === choice}
                      onChange={() => chooseConversation(choice)}
                    />
                    {{ normal: "普通の会話", scheduled: "定期実行", natural: "自然会話" }[choice]}
                  </label>
                ))}
              </div>
            </fieldset>
            {(partial || confirmed.length > 0) && (
              <div className="rounded border p-3 text-sm">
                {confirmed.length > 0 && (
                  <p className="whitespace-pre-wrap">
                    {confirmed.map(({ text }) => text).join("\n")}
                  </p>
                )}
                {partial && <p className="text-muted-foreground">{partial}</p>}
              </div>
            )}
            {reply && (
              <output className="block max-h-44 overflow-auto rounded border p-3 text-sm whitespace-pre-wrap">
                {playingText || reply}
              </output>
            )}
            {shownError && (
              <p
                role="alert"
                className="rounded border border-destructive p-3 text-sm text-destructive"
              >
                {shownError}
              </p>
            )}
          </div>
        )}
        <footer className="mt-5 flex flex-wrap gap-2">
          <button
            className="rounded bg-primary px-3 py-2 text-primary-foreground"
            onClick={() => void (running ? stop() : start())}
          >
            {running ? (
              <>
                <SquareIcon className="mr-1 inline" size={16} />
                停止
              </>
            ) : (
              <>
                <PlayIcon className="mr-1 inline" size={16} />
                常駐を開始
              </>
            )}
          </button>
          {settings.mode === "normal" && (
            <button
              className="rounded border px-3 py-2 disabled:opacity-50"
              onClick={sendConfirmed}
              disabled={
                !running ||
                !confirmed.length ||
                assistantState !== "idle" ||
                scheduledSpeech !== "idle" ||
                audioBusy
              }
            >
              <SendIcon className="mr-1 inline" size={16} />
              今すぐ送る
            </button>
          )}
          <button
            className="ml-auto rounded border p-2"
            aria-label="小窓で開く"
            onClick={() =>
              window.open(
                location.href,
                "tofu-madobe",
                "popup=yes,width=420,height=720,resizable=yes",
              )
            }
          >
            <PanelTopOpenIcon size={18} />
          </button>
          <button
            className="rounded border p-2"
            aria-label="設定"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={18} />
          </button>
        </footer>
        {settings.mode === "natural" && (
          <p className="mt-3 text-xs text-muted-foreground">
            VTube Studio: {vtubeConnected ? `接続・${hotkeys.length}件` : "任意"}
          </p>
        )}
      </section>
      {settingsOpen && (
        <div
          className="fixed inset-0 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <section className="max-h-full w-full max-w-md overflow-auto rounded-xl bg-background p-5">
            <header className="flex justify-between">
              <h2 className="font-semibold">設定</h2>
              <button onClick={() => setSettingsOpen(false)}>閉じる</button>
            </header>
            <div className="mt-4 space-y-4">
              {settings.scheduledEnabled && (
                <>
                  <label className="block">
                    定期発話の最短秒数
                    <input
                      className="mt-1 w-full"
                      type="number"
                      min="5"
                      max="1800"
                      value={settings.minSeconds}
                      onChange={(event) =>
                        update("minSeconds", clamp(Number(event.target.value), 5, 1800))
                      }
                    />
                  </label>
                  <label className="block">
                    定期発話の最長秒数
                    <input
                      className="mt-1 w-full"
                      type="number"
                      min={settings.minSeconds}
                      max="1800"
                      value={settings.maxSeconds}
                      onChange={(event) =>
                        update(
                          "maxSeconds",
                          clamp(Number(event.target.value), settings.minSeconds, 1800),
                        )
                      }
                    />
                  </label>
                </>
              )}
              <label className="block">
                割り込み時に先に話す文言（1行に1つ）
                <textarea
                  className="mt-1 w-full rounded border p-2"
                  rows={6}
                  value={settings.interruptPhrases}
                  onChange={(event) => update("interruptPhrases", event.target.value)}
                />
              </label>
              <label className="block">
                Jevが選ぶ相づち文言（1行に1つ）
                <textarea
                  className="mt-1 w-full rounded border p-2"
                  rows={6}
                  value={settings.backchannelPhrases}
                  onChange={(event) => update("backchannelPhrases", event.target.value)}
                />
              </label>
              <label className="block">
                システムプロンプト
                <textarea
                  className="mt-1 w-full rounded border p-2"
                  rows={5}
                  value={settings.system}
                  onChange={(event) => update("system", event.target.value)}
                  placeholder="空欄なら.envのOPENAI_SYSTEM_PROMPT"
                />
              </label>
              <label className="block">
                定期発話・話題提供プロンプト
                <textarea
                  className="mt-1 w-full rounded border p-2"
                  rows={4}
                  value={settings.soloPrompt}
                  onChange={(event) => update("soloPrompt", event.target.value)}
                />
              </label>
              <button
                className="rounded border border-destructive px-3 py-2 text-destructive"
                onClick={() => replaceHistory([])}
              >
                この画面の会話履歴を消去
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { debugError, debugLog, debugWarn } from "@/lib/debug-log";

export type AudioQueueItem = {
  sentenceIndex: number;
  text: string;
  audioUrl: string;
  onStarted?: () => void;
  onCompleted?: () => void;
};

export function useAudioQueue() {
  const tail = useRef(Promise.resolve());
  const generation = useRef(0);
  const sequence = useRef(0);
  const current = useRef<{ audio: HTMLAudioElement; finish: (reason?: string) => void } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [playingText, setPlayingText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const enqueue = useCallback((item: AudioQueueItem) => {
    const queuedGeneration = generation.current;
    const queueID = ++sequence.current;
    const scope = `audio-queue:${queuedGeneration}:${queueID}`;
    debugLog(scope, "enqueued", {
      sentenceIndex: item.sentenceIndex,
      text: item.text,
      audioUrl: item.audioUrl,
    });
    const next = tail.current.then(async () => {
      if (queuedGeneration !== generation.current) {
        debugWarn(scope, "discarded before playback: stale generation", {
          queuedGeneration,
          currentGeneration: generation.current,
        });
        return;
      }
      setBusy(true);
      setPlayingText(item.text);
      debugLog(scope, "playback task started");
      await new Promise<void>((resolve) => {
        const audio = new Audio(item.audioUrl);
        let finished = false;
        let started = false;
        const state = () => ({
          currentTime: audio.currentTime,
          duration: Number.isFinite(audio.duration) ? audio.duration : null,
          paused: audio.paused,
          ended: audio.ended,
          readyState: audio.readyState,
          networkState: audio.networkState,
        });
        const finish = (reason = "finish called") => {
          if (finished) return;
          finished = true;
          debugLog(scope, "playback task finished", { reason, ...state() });
          if (current.current?.audio === audio) current.current = null;
          resolve();
        };
        current.current = { audio, finish };
        for (const event of [
          "loadstart",
          "loadedmetadata",
          "canplay",
          "playing",
          "waiting",
          "stalled",
          "suspend",
          "abort",
          "emptied",
        ])
          audio.addEventListener(event, () => debugLog(scope, `audio ${event}`, state()));
        audio.addEventListener(
          "playing",
          () => {
            if (started) return;
            started = true;
            item.onStarted?.();
          },
          { once: true },
        );
        audio.addEventListener(
          "ended",
          () => {
            item.onCompleted?.();
            finish("ended event");
          },
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => {
            debugError(scope, "audio element error", audio.error?.message ?? "unknown error", {
              mediaErrorCode: audio.error?.code,
              ...state(),
            });
            setError("音声を再生できません。");
            finish("error event");
          },
          { once: true },
        );
        debugLog(scope, "audio.play called", state());
        void audio.play().then(
          () => debugLog(scope, "audio.play resolved", state()),
          (error: unknown) => {
            debugError(scope, "audio.play rejected", error, state());
            setError("音声を再生できません。");
            finish("audio.play rejected");
          },
        );
      });
    });
    tail.current = next;
    void next
      .catch((error: unknown) => debugError(scope, "queue task failed", error))
      .finally(() => {
        if (tail.current === next && queuedGeneration === generation.current) {
          setBusy(false);
          setPlayingText("");
          debugLog(scope, "queue became idle");
        } else {
          debugLog(scope, "queue task settled without clearing busy", {
            isTail: tail.current === next,
            queuedGeneration,
            currentGeneration: generation.current,
          });
        }
      });
  }, []);

  const waitForIdle = useCallback(async () => {
    const waitingFor = tail.current;
    debugLog("audio-queue", "waitForIdle started", {
      generation: generation.current,
      hasActiveAudio: !!current.current,
    });
    await waitingFor;
    debugLog("audio-queue", "waitForIdle completed", {
      generation: generation.current,
      tailUnchanged: waitingFor === tail.current,
      hasActiveAudio: !!current.current,
    });
  }, []);
  const stop = useCallback(() => {
    const previousGeneration = generation.current;
    generation.current += 1;
    const active = current.current;
    debugWarn("audio-queue", "stop requested", {
      previousGeneration,
      currentGeneration: generation.current,
      hasActiveAudio: !!active,
    });
    current.current = null;
    if (active) {
      active.audio.pause();
      active.audio.removeAttribute("src");
      active.audio.load();
      active.finish("queue stopped");
    }
    tail.current = Promise.resolve();
    setBusy(false);
    setPlayingText("");
    debugLog("audio-queue", "stop completed", { generation: generation.current });
  }, []);

  useEffect(() => stop, [stop]);
  return { enqueue, waitForIdle, stop, busy, playingText, error, clearError: () => setError(null) };
}

"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { triggerMotionHotkey } from "@/lib/vtube-studio";

export type AudioQueueItem = {
  sentenceIndex: number;
  text: string;
  audioUrl: string;
  motionTag?: string;
};

function play(
  item: AudioQueueItem,
  current: MutableRefObject<HTMLAudioElement | null>,
  setError: (message: string) => void,
) {
  return new Promise<void>((resolve) => {
    const audio = new Audio(item.audioUrl);
    current.current = audio;
    audio.addEventListener("ended", () => resolve(), { once: true });
    audio.addEventListener(
      "error",
      () => {
        setError("音声を再生できません。");
        resolve();
      },
      { once: true },
    );
    void audio.play().catch(() => {
      setError("音声を再生できません。");
      resolve();
    });
    if (item.motionTag)
      void triggerMotionHotkey(item.motionTag).catch((error: unknown) =>
        setError(
          error instanceof Error ? error.message : "VTube Studioのモーションを再生できません。",
        ),
      );
  });
}

export function useAudioQueue() {
  const tail = useRef(Promise.resolve());
  const current = useRef<HTMLAudioElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [playingText, setPlayingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const enqueue = useCallback((item: AudioQueueItem) => {
    setBusy(true);
    tail.current = tail.current
      .then(async () => {
        setPlayingText(item.text);
        await play(item, current, (message) => setError(message));
        current.current = null;
      })
      .finally(() => {
        setBusy(false);
        setPlayingText("");
      });
  }, []);
  const waitForIdle = useCallback(() => tail.current, []);
  const stop = useCallback(() => {
    current.current?.pause();
    current.current = null;
    tail.current = Promise.resolve();
    setBusy(false);
    setPlayingText("");
  }, []);
  useEffect(() => stop, [stop]);
  return { enqueue, waitForIdle, stop, busy, playingText, error, clearError: () => setError(null) };
}

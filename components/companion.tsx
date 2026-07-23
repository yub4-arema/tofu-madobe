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
import { useIntervalRecorder } from "@/hooks/use-interval-recorder";
import { isTurnEvent, type MotionHotkeyChoice } from "@/lib/protocol";
import { prepareMotionHotkeys } from "@/lib/vtube-studio";

type Mode = "manual" | "scheduled" | "auto";
type Phase = "stopped" | "listening" | "requesting" | "playing";
type Settings = {
  mode: Mode;
  minSeconds: number;
  maxSeconds: number;
  autoMinSpeechSeconds: number;
  autoSilenceSeconds: number;
  voiceThresholdPercent: number;
  system: string;
  soloPrompt: string;
};

const defaults: Settings = {
  mode: "scheduled",
  minSeconds: 180,
  maxSeconds: 420,
  autoMinSpeechSeconds: 2,
  autoSilenceSeconds: 2,
  voiceThresholdPercent: 2,
  system: "",
  soloPrompt:
    "直近の話題と重複しない、聞いて楽しめる短い話題を一つ自然に話してください。待機や自動発言には触れないでください。",
};

function status(phase: Phase, mic: boolean) {
  if (phase === "listening") return mic ? "録音中" : "待機中";
  if (phase === "requesting") return "返答を生成中";
  if (phase === "playing") return "発話中";
  return "停止中";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function readStream(response: Response, onEvent: (value: unknown) => void) {
  if (!response.body) throw new Error("応答ストリームがありません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
    if (done) break;
  }
  if (pending.trim()) onEvent(JSON.parse(pending));
}

export function Companion() {
  const recorder = useIntervalRecorder();
  const audio = useAudioQueue();
  const [phase, setPhase] = useState<Phase>("stopped");
  const [running, setRunning] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [compact, setCompact] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(defaults);
  const [reply, setReply] = useState("");
  const [history, setHistory] = useState<Array<{ role: "assistant"; content: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [vtubeConnected, setVtubeConnected] = useState(false);
  const submitRef = useRef<(mode: Mode) => Promise<void>>(async () => undefined);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("tofu-madobe:settings");
      if (saved) setSettings({ ...defaults, ...(JSON.parse(saved) as Partial<Settings>) });
    } catch {
      /* defaults */
    }
  }, []);
  useEffect(
    () => localStorage.setItem("tofu-madobe:settings", JSON.stringify(settings)),
    [settings],
  );
  useEffect(
    () => recorder.setVoiceThreshold(settings.voiceThresholdPercent / 100),
    [recorder.setVoiceThreshold, settings.voiceThresholdPercent],
  );

  const submit = useCallback(
    async (mode: Mode) => {
      if (!running || phase !== "listening") return;
      recorder.setEnabled(false);
      const recording = recorder.takeWav();
      if (!recording && mode === "manual") {
        recorder.setEnabled(micEnabled);
        setError("送信できる録音がまだありません。");
        return;
      }
      setError(null);
      setReply("");
      setPhase("requesting");
      let motionHotkeys: MotionHotkeyChoice[] = [];
      try {
        motionHotkeys = await prepareMotionHotkeys();
        setVtubeConnected(true);
      } catch {
        setVtubeConnected(false);
      }
      const form = new FormData();
      form.set("mode", mode);
      form.set("system", settings.system);
      form.set("soloPrompt", settings.soloPrompt);
      form.set("history", JSON.stringify(history.slice(-16)));
      form.set("motionHotkeys", JSON.stringify(motionHotkeys));
      if (recording) form.set("audio", recording, "interval.wav");
      try {
        const response = await fetch("/api/turn/stream", { method: "POST", body: form });
        if (!response.ok)
          throw new Error(
            ((await response.json().catch(() => null)) as { error?: { message?: string } } | null)
              ?.error?.message ?? "返答の生成に失敗しました。",
          );
        await readStream(response, (value) => {
          if (!isTurnEvent(value)) return;
          if (value.type === "text.delta") setReply((current) => current + value.delta);
          if (value.type === "audio.ready") {
            setPhase("playing");
            audio.enqueue({
              ...value,
              audioUrl: new URL(value.audioUrl, location.origin).toString(),
            });
          }
          if (value.type === "turn.completed") {
            setReply(value.text);
            setHistory((current) =>
              [...current, { role: "assistant" as const, content: value.text }].slice(-16),
            );
          }
          if (value.type === "turn.error") throw new Error(value.error.message);
        });
        await audio.waitForIdle();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "返答の生成に失敗しました。");
      } finally {
        setPhase(running ? "listening" : "stopped");
        if (running) recorder.setEnabled(micEnabled);
      }
    },
    [audio, history, micEnabled, phase, recorder, running, settings],
  );

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);
  useEffect(() => {
    if (!running || phase !== "listening" || settings.mode !== "scheduled") return;
    const source = new EventSource(
      `/api/schedule?min=${settings.minSeconds}&max=${settings.maxSeconds}`,
    );
    source.addEventListener("due", () => {
      source.close();
      void submitRef.current("scheduled");
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [phase, running, settings.maxSeconds, settings.minSeconds, settings.mode]);
  useEffect(() => {
    if (
      !running ||
      !micEnabled ||
      phase !== "listening" ||
      settings.mode !== "auto" ||
      recorder.speaking ||
      recorder.speechSeconds < settings.autoMinSpeechSeconds
    )
      return;
    const timer = window.setTimeout(
      () => void submitRef.current("auto"),
      settings.autoSilenceSeconds * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [
    micEnabled,
    phase,
    recorder.speaking,
    recorder.speechEndCount,
    recorder.speechSeconds,
    running,
    settings.autoMinSpeechSeconds,
    settings.autoSilenceSeconds,
    settings.mode,
  ]);

  const start = async () => {
    try {
      await recorder.start();
      recorder.setEnabled(micEnabled);
      setRunning(true);
      setPhase("listening");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "マイクを開始できません。");
    }
  };
  const stop = () => {
    setRunning(false);
    setPhase("stopped");
    recorder.stop();
    audio.stop();
  };
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const shownError = error ?? audio.error;

  return (
    <main className="mx-auto flex min-h-svh max-w-md items-center p-3">
      <section className="w-full rounded-xl border bg-background p-4 shadow-sm">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">tofu-madobe</h1>
            <p className="text-sm text-muted-foreground">{status(phase, micEnabled)}</p>
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
                マイク{" "}
                <small className="text-muted-foreground">
                  {recorder.bufferedSeconds.toFixed(1)}秒
                </small>
              </span>
              <input
                type="checkbox"
                checked={micEnabled}
                disabled={!running}
                onChange={(event) => {
                  setMicEnabled(event.target.checked);
                  if (running) recorder.setEnabled(event.target.checked);
                }}
              />
            </label>
            <div>
              <progress className="w-full" max="100" value={Math.min(100, recorder.level * 1000)} />
              <p className="text-xs text-muted-foreground">
                入力 {(recorder.level * 100).toFixed(1)}% / しきい値{" "}
                {settings.voiceThresholdPercent}%
              </p>
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">対話方法</legend>
              <div className="flex gap-2">
                {(["manual", "scheduled", "auto"] as Mode[]).map((mode) => (
                  <label key={mode} className="rounded border px-2 py-1 text-sm">
                    <input
                      className="mr-1"
                      type="radio"
                      checked={settings.mode === mode}
                      onChange={() => {
                        recorder.clear();
                        update("mode", mode);
                      }}
                    />
                    {{ manual: "手動", scheduled: "定期実行", auto: "自動対話" }[mode]}
                  </label>
                ))}
              </div>
            </fieldset>
            {reply && (
              <output className="block max-h-44 overflow-auto rounded border p-3 text-sm whitespace-pre-wrap">
                {audio.playingText || reply}
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
          <button
            className="rounded border px-3 py-2 disabled:opacity-50"
            onClick={() => void submit("manual")}
            disabled={!running || phase !== "listening"}
          >
            <SendIcon className="mr-1 inline" size={16} />
            今すぐ送る
          </button>
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
        <p className="mt-3 text-xs text-muted-foreground">
          VTube Studio: {vtubeConnected ? "接続" : "任意"}
        </p>
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
              <label className="block">
                定期実行の最短秒数
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
                定期実行の最長秒数
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
              <label className="block">
                自動対話の最低発話秒数
                <input
                  className="mt-1 w-full"
                  type="number"
                  min="1"
                  max="10"
                  step="0.5"
                  value={settings.autoMinSpeechSeconds}
                  onChange={(event) =>
                    update("autoMinSpeechSeconds", clamp(Number(event.target.value), 1, 10))
                  }
                />
              </label>
              <label className="block">
                自動対話の無音秒数
                <input
                  className="mt-1 w-full"
                  type="number"
                  min="1"
                  max="10"
                  step="0.5"
                  value={settings.autoSilenceSeconds}
                  onChange={(event) =>
                    update("autoSilenceSeconds", clamp(Number(event.target.value), 1, 10))
                  }
                />
              </label>
              <label className="block">
                音声しきい値（%）
                <input
                  className="mt-1 w-full"
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.5"
                  value={settings.voiceThresholdPercent}
                  onChange={(event) =>
                    update("voiceThresholdPercent", clamp(Number(event.target.value), 0.5, 10))
                  }
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
                録音が無い場合
                <textarea
                  className="mt-1 w-full rounded border p-2"
                  rows={4}
                  value={settings.soloPrompt}
                  onChange={(event) => update("soloPrompt", event.target.value)}
                />
              </label>
              <button
                className="rounded border border-destructive px-3 py-2 text-destructive"
                onClick={() => setHistory([])}
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

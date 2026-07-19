"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MicIcon,
  PanelTopOpenIcon,
  PlayIcon,
  RadioIcon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useAudioQueue } from "@/hooks/use-audio-queue"
import { useIntervalRecorder } from "@/hooks/use-interval-recorder"
import { readNdjson } from "@/lib/ndjson"
import { isTurnEvent, type MotionHotkeyChoice } from "@/lib/protocol"
import { vtubeStudio } from "@/lib/vtube-studio"

type Phase = "stopped" | "listening" | "requesting" | "playing"
type SubmitMode = "manual" | "scheduled" | "auto"
type InteractionMode = "manual" | "scheduled" | "auto"
type ConversationHistoryItem = { role: "assistant"; content: string }
type Settings = {
  interactionMode: InteractionMode
  minMinutes: number
  maxMinutes: number
  minSeconds: number
  maxSeconds: number
  autoMinSpeechSeconds: number
  autoSilenceSeconds: number
  voiceThresholdPercent: number
  system: string
  soloPrompt: string
}

const defaultSettings: Settings = {
  interactionMode: "scheduled",
  minMinutes: 3,
  maxMinutes: 7,
  minSeconds: 0,
  maxSeconds: 0,
  autoMinSpeechSeconds: 2,
  autoSilenceSeconds: 2,
  voiceThresholdPercent: 2,
  system: "",
  soloPrompt: "直近の話題と重複しない、聞いて楽しめる短い話題を一つ自然に話してください。待機や自動発言には触れないでください。",
}

function phaseLabel(phase: Phase, micEnabled: boolean) {
  if (phase === "listening") return micEnabled ? "録音中" : "待機中"
  if (phase === "requesting") return "返答を生成中"
  if (phase === "playing") return "発話中"
  return "停止中"
}

function secondsLabel(seconds: number) {
  if (seconds < 1) return "まだ発話なし"
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return minutes ? `${minutes}分${rest}秒の発話` : `${rest}秒の発話`
}

function modeDescription(settings: Settings) {
  if (settings.interactionMode === "auto") {
    return `${settings.autoMinSpeechSeconds}秒以上の発話後、${settings.autoSilenceSeconds}秒無音で送信`
  }
  if (settings.interactionMode === "scheduled") {
    return `${settings.minMinutes}分${settings.minSeconds}秒〜${settings.maxMinutes}分${settings.maxSeconds}秒後に録音を送信`
  }
  return "今すぐ送るボタンでのみ送信"
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

export function Companion() {
  const recorder = useIntervalRecorder()
  const audioQueue = useAudioQueue()
  const [phase, setPhase] = useState<Phase>("stopped")
  const [running, setRunning] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [compact, setCompact] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [reply, setReply] = useState("")
  const [conversationHistory, setConversationHistory] = useState<ConversationHistoryItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [vtubeConnected, setVtubeConnected] = useState(false)
  const [autoSilenceRemaining, setAutoSilenceRemaining] = useState<number | null>(null)
  const submitRef = useRef<(mode: SubmitMode) => Promise<void>>(async () => undefined)

  useEffect(() => {
    const stored = localStorage.getItem("tofu-madobe:settings")
    if (stored) {
      queueMicrotask(() => {
        try { setSettings({ ...defaultSettings, ...JSON.parse(stored) as Partial<Settings> }) } catch { /* use defaults */ }
      })
    }
  }, [])

  useEffect(() => {
    localStorage.setItem("tofu-madobe:settings", JSON.stringify(settings))
  }, [settings])

  const setVoiceThreshold = recorder.setVoiceThreshold
  useEffect(() => {
    setVoiceThreshold(settings.voiceThresholdPercent / 100)
  }, [setVoiceThreshold, settings.voiceThresholdPercent])

  const submit = useCallback(async (mode: SubmitMode) => {
    if (!running || (phase !== "listening" && phase !== "stopped")) return
    recorder.setEnabled(false)
    const audio = recorder.takeWav()
    if (!audio && mode === "manual") {
      recorder.setEnabled(micEnabled)
      toast.info("送信できる録音がまだありません。")
      return
    }
    setError(null)
    setReply("")
    setPhase("requesting")
    let motionHotkeys: MotionHotkeyChoice[] = []
    try {
      motionHotkeys = await vtubeStudio.prepare()
      setVtubeConnected(true)
    } catch (caught) {
      setVtubeConnected(false)
      const message = caught instanceof Error ? caught.message : "VTube Studioのモーションを読み込めません。"
      console.warn("[tofu-madobe]", message)
    }

    const form = new FormData()
    form.set("mode", mode)
    form.set("system", settings.system)
    form.set("soloPrompt", settings.soloPrompt)
    form.set("motionHotkeys", JSON.stringify(motionHotkeys))
    form.set("history", JSON.stringify(conversationHistory.slice(-16)))
    if (audio) form.set("audio", audio, "interval.wav")

    try {
      const response = await fetch("/api/turn/stream", { method: "POST", body: form })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? "返答の生成に失敗しました。")
      }
      await readNdjson(response, (value) => {
        if (!isTurnEvent(value)) return
        if (value.type === "text.delta") setReply((current) => current + value.delta)
        if (value.type === "audio.ready") {
          setPhase("playing")
          audioQueue.enqueue({
            sentenceIndex: value.sentenceIndex,
            text: value.text,
            motionTag: value.motionTag,
            audioUrl: new URL(value.audioUrl, location.origin).toString(),
          })
        }
        if (value.type === "turn.completed") {
          setReply(value.text)
          setConversationHistory((current) => [
            ...current,
            { role: "assistant" as const, content: value.text },
          ].slice(-16))
        }
        if (value.type === "turn.error") throw new Error(value.error.message)
      })
      await audioQueue.waitForIdle()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "返答の生成に失敗しました。"
      setError(message)
      toast.error(message)
    } finally {
      if (running) {
        setPhase("listening")
        recorder.setEnabled(micEnabled)
      } else {
        setPhase("stopped")
      }
    }
  }, [audioQueue, conversationHistory, micEnabled, phase, recorder, running, settings])

  useEffect(() => {
    submitRef.current = submit
  }, [submit])

  useEffect(() => {
    if (!running || settings.interactionMode !== "scheduled" || phase !== "listening") return
    const source = new EventSource(
      `/api/schedule?min=${settings.minMinutes * 60 + settings.minSeconds}&max=${settings.maxMinutes * 60 + settings.maxSeconds}`
    )
    const handleDue = () => {
      source.close()
      void submitRef.current("scheduled")
    }
    source.addEventListener("due", handleDue)
    source.onerror = () => source.close()
    return () => source.close()
  }, [phase, running, settings.interactionMode, settings.maxMinutes, settings.maxSeconds, settings.minMinutes, settings.minSeconds])

  useEffect(() => {
    setAutoSilenceRemaining(null)
    if (
      !running ||
      !micEnabled ||
      settings.interactionMode !== "auto" ||
      phase !== "listening" ||
      recorder.speaking ||
      recorder.speechSeconds < settings.autoMinSpeechSeconds
    ) return

    const silenceMs = settings.autoSilenceSeconds * 1000
    const deadline = performance.now() + silenceMs
    const updateRemaining = () => {
      setAutoSilenceRemaining(Math.max(0, (deadline - performance.now()) / 1000))
    }
    updateRemaining()
    const intervalId = window.setInterval(updateRemaining, 100)
    const timeoutId = window.setTimeout(() => {
      window.clearInterval(intervalId)
      setAutoSilenceRemaining(0)
      console.log("[tofu-madobe] auto conversation silence elapsed", {
        speechSeconds: recorder.speechSeconds,
        silenceSeconds: settings.autoSilenceSeconds,
      })
      void submitRef.current("auto")
    }, silenceMs)
    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
    }
  }, [
    micEnabled,
    phase,
    recorder.speechSeconds,
    recorder.speaking,
    recorder.speechEndCount,
    running,
    settings.autoMinSpeechSeconds,
    settings.autoSilenceSeconds,
    settings.interactionMode,
  ])

  const start = useCallback(async () => {
    try {
      await recorder.start()
      recorder.setEnabled(micEnabled)
      setRunning(true)
      setPhase("listening")
      setError(null)
      toast.success("常駐を開始しました。")
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "マイクを開始できません。"
      setError(message)
      toast.error(message)
    }
  }, [micEnabled, recorder])

  const stop = useCallback(() => {
    setRunning(false)
    setPhase("stopped")
    recorder.stop()
    audioQueue.stop()
  }, [audioQueue, recorder])

  const toggleMic = useCallback((checked: boolean) => {
    setMicEnabled(checked)
    if (running && phase === "listening") recorder.setEnabled(checked)
  }, [phase, recorder, running])

  const changeInteractionMode = useCallback((value: string) => {
    if (value !== "manual" && value !== "scheduled" && value !== "auto") return
    recorder.clear()
    setSettings((current) => ({ ...current, interactionMode: value }))
  }, [recorder])

  const openPopup = () => {
    window.open(location.href, "tofu-madobe", "popup=yes,width=420,height=720,resizable=yes")
  }

  const clearHistory = async () => {
    const response = await fetch("/api/history", { method: "DELETE" })
    if (response.ok) {
      setConversationHistory([])
      toast.success("会話履歴と送信済み録音を消去しました。")
    }
    else toast.error("履歴を消去できませんでした。")
  }

  const shownError = error ?? audioQueue.error
  const statusVariant = phase === "stopped" ? "secondary" : phase === "listening" ? "outline" : "default"
  const totalSpeechSeconds = recorder.speechSeconds + recorder.currentSpeechSeconds
  const inputLevelPercent = recorder.level * 100
  const voiceThreshold = settings.voiceThresholdPercent / 100

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-3">
      <Card className="w-full max-w-[420px]" size={compact ? "sm" : "default"}>
        <Collapsible open={!compact} onOpenChange={(open) => setCompact(!open)}>
          <CardHeader>
            <CardTitle>tofu-madobe</CardTitle>
            <CardDescription>{phaseLabel(phase, micEnabled)}</CardDescription>
            <CardAction className="flex items-center gap-2">
              <Badge variant={statusVariant}>{phaseLabel(phase, micEnabled)}</Badge>
              <CollapsibleTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label={compact ? "展開" : "折りたたむ"} />}
              >
                {compact ? <ChevronDownIcon /> : <ChevronUpIcon />}
              </CollapsibleTrigger>
            </CardAction>
          </CardHeader>

          {compact ? (
            <CardFooter className="justify-between gap-2">
              <div className="flex items-center gap-2">
                <MicIcon />
                <Switch checked={micEnabled} onCheckedChange={toggleMic} disabled={!running} aria-label="マイク" />
              </div>
              <Button size="sm" onClick={() => void submit("manual")} disabled={!running || phase !== "listening"}>
                <SendIcon data-icon="inline-start" />
                今すぐ送る
              </Button>
            </CardFooter>
          ) : null}

          <CollapsibleContent>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <MicIcon />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">マイク</span>
                    <span className="text-xs text-muted-foreground">{secondsLabel(recorder.bufferedSeconds)}</span>
                  </div>
                </div>
                <Switch checked={micEnabled} onCheckedChange={toggleMic} disabled={!running} aria-label="マイク" />
              </div>
              <Progress
                value={Math.min(100, Math.round(inputLevelPercent * 10))}
                aria-label="入力音量"
              />
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>入力 {inputLevelPercent.toFixed(1)}%</span>
                <span>判定しきい値 {(voiceThreshold * 100).toFixed(1)}%</span>
              </div>

              <div className="flex flex-col gap-2">
                <Tabs value={settings.interactionMode} onValueChange={changeInteractionMode}>
                  <TabsList className="w-full">
                    <TabsTrigger value="manual">手動</TabsTrigger>
                    <TabsTrigger value="scheduled">定期実行</TabsTrigger>
                    <TabsTrigger value="auto">自動対話</TabsTrigger>
                  </TabsList>
                </Tabs>
                <div className="flex items-center gap-2">
                  <RadioIcon />
                  <span className="text-xs text-muted-foreground">{modeDescription(settings)}</span>
                </div>
                {settings.interactionMode === "auto" ? (
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <Badge variant={recorder.speaking ? "default" : "outline"}>
                      {recorder.speaking
                        ? "発話検知中"
                        : autoSilenceRemaining !== null
                          ? `送信まで ${autoSilenceRemaining.toFixed(1)}秒`
                          : "発話待ち"}
                    </Badge>
                    <span className="text-muted-foreground">
                      発話 {totalSpeechSeconds.toFixed(1)} / {settings.autoMinSpeechSeconds.toFixed(1)}秒
                    </span>
                  </div>
                ) : null}
              </div>

              {reply ? (
                <ScrollArea className="max-h-44 rounded-lg border p-3">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed" aria-live="polite">{audioQueue.playingText || reply}</p>
                </ScrollArea>
              ) : null}

              {shownError ? (
                <Alert variant="destructive">
                  <AlertTitle>エラー</AlertTitle>
                  <AlertDescription>{shownError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex gap-2">
                {running ? (
                  <Button variant="outline" onClick={stop}>
                    <SquareIcon data-icon="inline-start" />
                    停止
                  </Button>
                ) : (
                  <Button onClick={() => void start()}>
                    <PlayIcon data-icon="inline-start" />
                    常駐を開始
                  </Button>
                )}
                <Button
                  className="flex-1"
                  onClick={() => void submit("manual")}
                  disabled={!running || phase !== "listening"}
                >
                  {phase === "requesting" || phase === "playing" ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
                  今すぐ送る
                </Button>
              </div>
            </CardContent>

            <CardFooter className="mt-4 justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">VTube {vtubeConnected ? "接続" : "任意"}</Badge>
                <span>閉じる・PCスリープでは停止</span>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon-sm" onClick={openPopup} aria-label="小窓で開く">
                  <PanelTopOpenIcon />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)} aria-label="設定">
                  <SettingsIcon />
                </Button>
              </div>
            </CardFooter>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>設定</SheetTitle>
            <SheetDescription>録音区間とAItuberの話し方を設定します。</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">
            <FieldGroup>
              <Field>
                <FieldLabel>定期実行の範囲（分）</FieldLabel>
                <Slider
                  min={0}
                  max={30}
                  step={1}
                  value={[settings.minMinutes, settings.maxMinutes]}
                  onValueChange={(value) => {
                    const values = Array.isArray(value) ? value : [3, 7]
                    setSettings((current) => ({ ...current, minMinutes: values[0], maxMinutes: values[1] }))
                  }}
                />
                <FieldDescription>{settings.minMinutes}〜{settings.maxMinutes}分の間で毎回ランダムです。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>定期実行の範囲（秒）</FieldLabel>
                <Slider
                  min={0}
                  max={59}
                  step={1}
                  value={[settings.minSeconds, settings.maxSeconds]}
                  onValueChange={(value) => {
                    const values = Array.isArray(value) ? value : [0, 0]
                    setSettings((current) => ({ ...current, minSeconds: values[0], maxSeconds: values[1] }))
                  }}
                />
                <FieldDescription>{settings.minSeconds}〜{settings.maxSeconds}秒を加算します。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>自動対話: 最低発話時間</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  step={0.5}
                  value={settings.autoMinSpeechSeconds}
                  onChange={(event) => {
                    const seconds = Number(event.target.value)
                    if (Number.isFinite(seconds)) {
                      setSettings((current) => ({ ...current, autoMinSpeechSeconds: clamp(seconds, 1, 10) }))
                    }
                  }}
                />
                <FieldDescription>{settings.autoMinSpeechSeconds}秒以上の発話を自動送信の対象にします。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>自動対話: 無音時間</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  step={0.5}
                  value={settings.autoSilenceSeconds}
                  onChange={(event) => {
                    const seconds = Number(event.target.value)
                    if (Number.isFinite(seconds)) {
                      setSettings((current) => ({ ...current, autoSilenceSeconds: clamp(seconds, 1, 10) }))
                    }
                  }}
                />
                <FieldDescription>{settings.autoSilenceSeconds}秒間の無音で自動送信します。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>音声しきい値</FieldLabel>
                <Input
                  type="number"
                  min={0.5}
                  max={10}
                  step={0.5}
                  value={settings.voiceThresholdPercent}
                  onChange={(event) => {
                    const percent = Number(event.target.value)
                    if (Number.isFinite(percent)) {
                      setSettings((current) => ({ ...current, voiceThresholdPercent: clamp(percent, 0.5, 10) }))
                    }
                  }}
                />
                <FieldDescription>{settings.voiceThresholdPercent}%（低いほど小さな音にも反応します）</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="system-prompt">システムプロンプト</FieldLabel>
                <Textarea
                  id="system-prompt"
                  value={settings.system}
                  onChange={(event) => setSettings((current) => ({ ...current, system: event.target.value }))}
                  placeholder="空欄なら.envのOPENAI_SYSTEM_PROMPT"
                  rows={6}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="solo-prompt">録音が無い場合</FieldLabel>
                <Textarea
                  id="solo-prompt"
                  value={settings.soloPrompt}
                  onChange={(event) => setSettings((current) => ({ ...current, soloPrompt: event.target.value }))}
                  rows={5}
                />
              </Field>
              <Field>
                <FieldLabel>ローカルデータ</FieldLabel>
                <FieldDescription>送信済み録音と会話履歴はサーバーの.dataだけに保存されます。</FieldDescription>
                <Button variant="destructive" onClick={() => void clearHistory()}>
                  <Trash2Icon data-icon="inline-start" />
                  履歴と録音を消去
                </Button>
              </Field>
            </FieldGroup>
          </div>
        </SheetContent>
      </Sheet>
    </main>
  )
}

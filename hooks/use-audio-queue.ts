"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { vtubeStudio } from "@/lib/vtube-studio"

export type AudioQueueItem = {
  sentenceIndex: number
  text: string
  audioUrl: string
  motionTag?: string
}

export function useAudioQueue() {
  const queueRef = useRef<AudioQueueItem[]>([])
  const playingRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const waitersRef = useRef<Array<() => void>>([])
  const [busy, setBusy] = useState(false)
  const [playingText, setPlayingText] = useState("")
  const [error, setError] = useState<string | null>(null)

  const resolveIdle = useCallback(() => {
    if (playingRef.current || queueRef.current.length) return
    setBusy(false)
    setPlayingText("")
    waitersRef.current.splice(0).forEach((resolve) => resolve())
  }, [])

  const drain = useCallback(async function drainQueue() {
    if (playingRef.current) return
    const item = queueRef.current.shift()
    if (!item) {
      resolveIdle()
      return
    }
    playingRef.current = true
    setBusy(true)
    setPlayingText(item.text)
    if (item.motionTag) {
      void vtubeStudio.trigger(item.motionTag).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "VTube Studioのモーションを再生できません。")
      })
    }
    const audio = new Audio(item.audioUrl)
    audioRef.current = audio
    try {
      await audio.play()
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener("ended", () => resolve(), { once: true })
        audio.addEventListener("error", () => reject(new Error("音声を再生できません。")), { once: true })
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "音声を再生できません。")
    } finally {
      playingRef.current = false
      audioRef.current = null
      queueMicrotask(() => void drainQueue())
    }
  }, [resolveIdle])

  const enqueue = useCallback((item: AudioQueueItem) => {
    queueRef.current.push(item)
    queueRef.current.sort((left, right) => left.sentenceIndex - right.sentenceIndex)
    setBusy(true)
    void drain()
  }, [drain])

  const waitForIdle = useCallback(() => {
    if (!playingRef.current && !queueRef.current.length) return Promise.resolve()
    return new Promise<void>((resolve) => waitersRef.current.push(resolve))
  }, [])

  const stop = useCallback(() => {
    queueRef.current = []
    audioRef.current?.pause()
    audioRef.current = null
    playingRef.current = false
    resolveIdle()
  }, [resolveIdle])

  useEffect(() => stop, [stop])
  return { enqueue, waitForIdle, stop, busy, playingText, error, clearError: () => setError(null) }
}

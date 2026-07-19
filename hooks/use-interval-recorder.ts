"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { encodeSpeechSegments } from "@/lib/wav"

const maxSpeechSeconds = 240

export function useIntervalRecorder() {
  const contextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const enabledRef = useRef(false)
  const segmentsRef = useRef<Float32Array[][]>([])
  const currentRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(48_000)
  const voiceThresholdRef = useRef(0.02)
  const speechSecondsRef = useRef(0)
  const [ready, setReady] = useState(false)
  const [enabled, setEnabledState] = useState(false)
  const [level, setLevel] = useState(0)
  const [bufferedSeconds, setBufferedSeconds] = useState(0)
  const [speaking, setSpeaking] = useState(false)
  const [speechSeconds, setSpeechSeconds] = useState(0)
  const [currentSpeechSeconds, setCurrentSpeechSeconds] = useState(0)
  const [speechEndCount, setSpeechEndCount] = useState(0)

  const refreshDuration = useCallback(() => {
    const samples = [...segmentsRef.current, currentRef.current].reduce(
      (total, segment) => total + segment.reduce((sum, chunk) => sum + chunk.length, 0),
      0
    )
    setBufferedSeconds(samples / sampleRateRef.current)
  }, [])

  const finalizeCurrent = useCallback(() => {
    if (currentRef.current.length) segmentsRef.current.push(currentRef.current)
    currentRef.current = []
    let total = segmentsRef.current.reduce(
      (sum, segment) => sum + segment.reduce((value, chunk) => value + chunk.length, 0),
      0
    )
    const maxSamples = maxSpeechSeconds * sampleRateRef.current
    while (total > maxSamples && segmentsRef.current.length > 1) {
      const removed = segmentsRef.current.shift() ?? []
      total -= removed.reduce((sum, chunk) => sum + chunk.length, 0)
    }
    refreshDuration()
  }, [refreshDuration])

  const start = useCallback(async () => {
    if (contextRef.current) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    const context = new AudioContext()
    await context.audioWorklet.addModule("/interval-capture-worklet.js")
    const source = context.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(context, "interval-capture")
    const silentGain = context.createGain()
    silentGain.gain.value = 0
    source.connect(worklet).connect(silentGain).connect(context.destination)
    sampleRateRef.current = context.sampleRate
    worklet.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type === "chunk" && event.data.samples instanceof Float32Array) {
        if (!enabledRef.current) return
        currentRef.current.push(event.data.samples)
        if (currentRef.current.length % 40 === 0) refreshDuration()
      } else if (event.data?.type === "speech-end") {
        if (!enabledRef.current) return
        finalizeCurrent()
        const duration = Math.max(0, Number(event.data.speechSeconds) || 0)
        speechSecondsRef.current += duration
        console.log("[tofu-madobe] VAD speech ended", {
          segmentSpeechSeconds: duration,
          accumulatedSpeechSeconds: speechSecondsRef.current,
          threshold: voiceThresholdRef.current,
        })
        setSpeechSeconds(speechSecondsRef.current)
        setCurrentSpeechSeconds(0)
        setSpeaking(false)
        setSpeechEndCount((count) => count + 1)
      } else if (event.data?.type === "speech-start") {
        console.log("[tofu-madobe] VAD speech started", {
          threshold: voiceThresholdRef.current,
          accumulatedSpeechSeconds: speechSecondsRef.current,
        })
        setSpeaking(true)
      } else if (event.data?.type === "level") {
        setLevel(Number(event.data.value) || 0)
        setCurrentSpeechSeconds(Math.max(0, Number(event.data.currentSpeechSeconds) || 0))
      }
    }
    contextRef.current = context
    streamRef.current = stream
    workletRef.current = worklet
    setReady(true)
    enabledRef.current = true
    setEnabledState(true)
    worklet.port.postMessage({ type: "enabled", value: true })
    worklet.port.postMessage({ type: "minimum-threshold", value: voiceThresholdRef.current })
    await context.resume()
  }, [finalizeCurrent, refreshDuration])

  const setEnabled = useCallback((value: boolean) => {
    enabledRef.current = value
    setEnabledState(value)
    workletRef.current?.port.postMessage({ type: "enabled", value })
    if (!value) {
      finalizeCurrent()
      setLevel(0)
      setSpeaking(false)
    }
  }, [finalizeCurrent])

  const setVoiceThreshold = useCallback((value: number) => {
    const threshold = Math.min(Math.max(value, 0.005), 0.1)
    voiceThresholdRef.current = threshold
    workletRef.current?.port.postMessage({ type: "minimum-threshold", value: threshold })
  }, [])

  const clear = useCallback(() => {
    segmentsRef.current = []
    currentRef.current = []
    speechSecondsRef.current = 0
    setBufferedSeconds(0)
    setSpeechSeconds(0)
    setCurrentSpeechSeconds(0)
    setSpeaking(false)
  }, [])

  const takeWav = useCallback(() => {
    finalizeCurrent()
    const segments = segmentsRef.current
    segmentsRef.current = []
    currentRef.current = []
    speechSecondsRef.current = 0
    setBufferedSeconds(0)
    setSpeechSeconds(0)
    setCurrentSpeechSeconds(0)
    if (!segments.length) return null
    return encodeSpeechSegments(segments, sampleRateRef.current)
  }, [finalizeCurrent])

  const stop = useCallback(() => {
    workletRef.current?.port.postMessage({ type: "enabled", value: false })
    workletRef.current?.disconnect()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void contextRef.current?.close()
    workletRef.current = null
    streamRef.current = null
    contextRef.current = null
    segmentsRef.current = []
    currentRef.current = []
    speechSecondsRef.current = 0
    setReady(false)
    enabledRef.current = false
    setEnabledState(false)
    setLevel(0)
    setBufferedSeconds(0)
    setSpeechSeconds(0)
    setCurrentSpeechSeconds(0)
    setSpeaking(false)
  }, [])

  useEffect(() => stop, [stop])
  return {
    start,
    stop,
    setEnabled,
    setVoiceThreshold,
    takeWav,
    clear,
    ready,
    enabled,
    level,
    bufferedSeconds,
    speechSeconds,
    currentSpeechSeconds,
    speaking,
    speechEndCount,
  }
}

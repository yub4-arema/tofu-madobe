class IntervalCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.enabled = false
    this.speaking = false
    this.silenceSamples = 0
    this.voicedSamples = 0
    this.speechSamples = 0
    this.minimumThreshold = 0.02
    this.preRoll = []
    this.levelCounter = 0
    this.port.onmessage = (event) => {
      if (event.data?.type === "enabled") {
        this.enabled = Boolean(event.data.value)
        if (!this.enabled) this.finishSpeech()
      }
      if (event.data?.type === "minimum-threshold") {
        const value = Number(event.data.value)
        if (Number.isFinite(value)) this.minimumThreshold = Math.min(Math.max(value, 0.005), 0.1)
      }
    }
  }

  finishSpeech() {
    if (this.speaking) {
      this.port.postMessage({ type: "speech-end", speechSeconds: this.speechSamples / sampleRate })
    }
    this.speaking = false
    this.silenceSamples = 0
    this.voicedSamples = 0
    this.speechSamples = 0
    this.preRoll = []
  }

  sendChunk(channel) {
    const copy = new Float32Array(channel)
    this.port.postMessage({ type: "chunk", samples: copy }, [copy.buffer])
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel || !this.enabled) return true

    let energy = 0
    for (let index = 0; index < channel.length; index += 1) energy += channel[index] * channel[index]
    const rms = Math.sqrt(energy / channel.length)
    const threshold = this.minimumThreshold
    const voiced = rms >= threshold
    this.levelCounter += 1
    if (this.levelCounter >= 8) {
      this.levelCounter = 0
      this.port.postMessage({
        type: "level",
        value: rms,
        threshold: this.minimumThreshold,
        voiced,
        speaking: this.speaking,
        currentSpeechSeconds: this.speechSamples / sampleRate,
      })
    }

    if (voiced) {
      if (!this.speaking) {
        this.voicedSamples += channel.length
        this.preRoll.push(new Float32Array(channel))
        if (this.voicedSamples < sampleRate * 0.12) return true
        this.speaking = true
        this.port.postMessage({ type: "speech-start" })
        this.speechSamples = this.voicedSamples
        for (const chunk of this.preRoll) this.sendChunk(chunk)
        this.preRoll = []
        this.silenceSamples = 0
        return true
      }
      this.silenceSamples = 0
      this.speechSamples += channel.length
      this.sendChunk(channel)
    } else if (this.speaking) {
      this.sendChunk(channel)
      this.silenceSamples += channel.length
      if (this.silenceSamples >= sampleRate * 0.55) this.finishSpeech()
    } else {
      this.voicedSamples = 0
      this.preRoll.push(new Float32Array(channel))
      const maxChunks = Math.ceil((sampleRate * 0.15) / channel.length)
      if (this.preRoll.length > maxChunks) this.preRoll.shift()
    }
    return true
  }
}

registerProcessor("interval-capture", IntervalCaptureProcessor)

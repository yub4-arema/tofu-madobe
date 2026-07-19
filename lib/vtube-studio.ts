import type { MotionHotkeyChoice } from "./protocol"

const wsUrl = process.env.NEXT_PUBLIC_VTUBE_STUDIO_WS_URL ?? "ws://127.0.0.1:8001"
const pluginName = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_NAME ?? "tofu-madobe"
const pluginDeveloper = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_DEVELOPER ?? "tofu"
const tokenKey = "tofu-madobe:vtube-studio-token"
const apiName = "VTubeStudioPublicAPI"
const apiVersion = "1.0"
const requestTimeoutMs = 8_000

type VTubeStudioMessage<TData = unknown> = {
  requestID: string
  messageType: string
  data?: TData
}

type Hotkey = { name?: string; type?: string; file?: string; hotkeyID?: string }
type HotkeysResponse = { availableHotkeys?: Hotkey[] }
type AuthenticationTokenResponse = { authenticationToken?: string }
type AuthenticationResponse = { authenticated?: boolean; reason?: string }

export type TriggeredMotionHotkey = {
  hotkeyID?: string
  name?: string
  type?: string
  file?: string
}

export type MotionTriggerContext = {
  audioUrl: string
  sentenceIndex: number
  text: string
}

function logPrefix() {
  return `[${new Date().toISOString()}] [VTube Studio]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getHotkeyTag(hotkey: Hotkey) {
  const name = hotkey.name?.trim()
  return name && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name.toLowerCase() : null
}

function isUsableMotionHotkey(hotkey: Hotkey) {
  return Boolean(hotkey.hotkeyID) && hotkey.type === "TriggerAnimation" &&
    Boolean(hotkey.file?.toLowerCase().endsWith(".motion3.json")) && getHotkeyTag(hotkey) !== null
}

function describeHotkey(hotkey: Hotkey): TriggeredMotionHotkey {
  return {
    hotkeyID: hotkey.hotkeyID,
    name: hotkey.name,
    type: hotkey.type,
    file: hotkey.file,
  }
}

class VTubeStudioClient {
  private socketPromise: Promise<WebSocket> | null = null
  private pending = new Map<string, {
    reject(error: Error): void
    resolve(message: VTubeStudioMessage): void
    timeoutId: number
  }>()
  private hotkeys = new Map<string, Hotkey>()

  async prepareMotionHotkeys(): Promise<MotionHotkeyChoice[]> {
    console.log(logPrefix(), "prepareMotionHotkeys start", { wsUrl, pluginName, pluginDeveloper })
    await this.authenticate()

    const response = await this.request<HotkeysResponse>("HotkeysInCurrentModelRequest", {})
    const available = response.availableHotkeys?.filter((hotkey) => hotkey.hotkeyID) ?? []
    const usable = available.filter(isUsableMotionHotkey)
    const counts = new Map<string, number>()
    for (const hotkey of usable) {
      const tag = getHotkeyTag(hotkey)
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }

    const unique = usable
      .filter((hotkey) => counts.get(getHotkeyTag(hotkey) ?? "") === 1)
      .slice(0, 50)
    this.hotkeys = new Map(unique.map((hotkey) => [getHotkeyTag(hotkey) as string, hotkey]))

    console.log(logPrefix(), "hotkeys loaded", {
      total: response.availableHotkeys?.length ?? 0,
      availableWithId: available.length,
      usableMotionHotkeys: unique.map(describeHotkey),
      ignoredDuplicateNames: Array.from(counts).filter(([, count]) => count > 1).map(([tag]) => tag),
    })
    if (!unique.length) {
      console.warn(logPrefix(), "no usable motion hotkey", {
        availableHotkeys: available.map(describeHotkey),
      })
      throw new Error("VTube Studioに一意な名前のmotion3 Hotkeyが見つかりません。")
    }

    const choices = Array.from(this.hotkeys, ([tag, hotkey]) => ({
      tag,
      name: hotkey.name || hotkey.file || tag,
    }))
    console.log(logPrefix(), "motion tags prepared", { choices })
    return choices
  }

  async triggerMotionHotkey(tag: string, context: MotionTriggerContext) {
    const hotkey = this.hotkeys.get(tag)
    if (!hotkey?.hotkeyID) throw new Error(`VTube Studio motion tag is not available: ${tag}`)

    const response = await this.request<HotkeysResponse>("HotkeysInCurrentModelRequest", {})
    const current = response.availableHotkeys?.find((candidate) =>
      candidate.hotkeyID === hotkey.hotkeyID && getHotkeyTag(candidate) === tag && isUsableMotionHotkey(candidate)
    )
    if (!current?.hotkeyID) {
      this.hotkeys.delete(tag)
      throw new Error(`VTube Studio motion hotkey no longer exists: ${tag}`)
    }

    console.log(logPrefix(), "triggering AI-selected hotkey", {
      tag,
      context,
      hotkey: describeHotkey(current),
    })
    await this.request("HotkeyTriggerRequest", { hotkeyID: current.hotkeyID })
    console.log(logPrefix(), "hotkey triggered", {
      tag,
      context,
      hotkey: describeHotkey(current),
    })
    return describeHotkey(current)
  }

  private async authenticate() {
    const storedToken = localStorage.getItem(tokenKey)
    console.log(logPrefix(), "authentication start", { hasStoredToken: Boolean(storedToken) })
    if (storedToken && await this.tryAuthenticate(storedToken)) return

    const tokenResponse = await this.request<AuthenticationTokenResponse>("AuthenticationTokenRequest", {
      pluginName,
      pluginDeveloper,
    })
    const token = tokenResponse.authenticationToken
    if (!token) throw new Error("VTube Studio did not return an authentication token.")
    localStorage.setItem(tokenKey, token)
    if (!await this.tryAuthenticate(token)) {
      localStorage.removeItem(tokenKey)
      throw new Error("VTube Studio authentication was rejected.")
    }
  }

  private async tryAuthenticate(authenticationToken: string) {
    const response = await this.request<AuthenticationResponse>("AuthenticationRequest", {
      pluginName,
      pluginDeveloper,
      authenticationToken,
    })
    console.log(logPrefix(), "authentication response", response)
    return response.authenticated === true
  }

  private async request<TResponseData>(messageType: string, data: Record<string, unknown>) {
    const socket = await this.connect()
    const requestID = crypto.randomUUID()
    console.log(logPrefix(), "request send", {
      requestID,
      messageType,
      data,
      pendingBeforeSend: this.pending.size,
    })

    return new Promise<TResponseData>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(requestID)
        console.warn(logPrefix(), "request timeout", { requestID, messageType })
        reject(new Error(`VTube Studio request timed out: ${messageType}`))
      }, requestTimeoutMs)

      this.pending.set(requestID, {
        timeoutId,
        resolve: (message) => resolve((message.data ?? {}) as TResponseData),
        reject,
      })
      socket.send(JSON.stringify({ apiName, apiVersion, requestID, messageType, data }))
    })
  }

  private connect() {
    if (this.socketPromise) return this.socketPromise
    console.log(logPrefix(), "connecting websocket", { wsUrl })
    this.socketPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      socket.addEventListener("open", () => {
        console.log(logPrefix(), "websocket connected", { wsUrl })
        resolve(socket)
      }, { once: true })
      socket.addEventListener("error", () => {
        this.socketPromise = null
        console.warn(logPrefix(), "websocket connection error", { wsUrl })
        reject(new Error(`VTube Studioへ接続できません: ${wsUrl}`))
      }, { once: true })
      socket.addEventListener("close", () => {
        this.socketPromise = null
        console.warn(logPrefix(), "websocket closed", { pendingRequests: this.pending.size })
        for (const [requestID, pending] of this.pending) {
          window.clearTimeout(pending.timeoutId)
          pending.reject(new Error("VTube Studio connection was closed."))
          this.pending.delete(requestID)
        }
      })
      socket.addEventListener("message", (event) => this.handleMessage(event.data))
    })
    return this.socketPromise
  }

  private handleMessage(rawMessage: unknown) {
    console.log(logPrefix(), "raw message received", { rawMessage })
    if (typeof rawMessage !== "string" || !rawMessage.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(rawMessage) as unknown
    } catch (error) {
      console.warn(logPrefix(), "ignored malformed websocket message", { rawMessage, error })
      return
    }
    if (!isRecord(parsed) || typeof parsed.requestID !== "string" || typeof parsed.messageType !== "string") return
    const message = parsed as VTubeStudioMessage
    const pending = this.pending.get(message.requestID)
    if (!pending) return

    window.clearTimeout(pending.timeoutId)
    this.pending.delete(message.requestID)
    if (message.messageType === "APIError") {
      const errorMessage = isRecord(message.data) && typeof message.data.message === "string"
        ? message.data.message
        : "VTube Studio API returned an error."
      console.warn(logPrefix(), "API error response", { requestID: message.requestID, data: message.data })
      pending.reject(new Error(errorMessage))
      return
    }
    console.log(logPrefix(), "response received", {
      requestID: message.requestID,
      messageType: message.messageType,
      data: message.data,
    })
    pending.resolve(message)
  }
}

const vtubeStudioClient = new VTubeStudioClient()

export function prepareMotionHotkeys() {
  return vtubeStudioClient.prepareMotionHotkeys()
}

export function triggerMotionHotkey(tag: string, context: MotionTriggerContext) {
  return vtubeStudioClient.triggerMotionHotkey(tag, context)
}

// 既存の呼び出し側を変えず、vtube-live-systemと同じ実装へ委譲する薄い互換層。
export const vtubeStudio = {
  prepare: prepareMotionHotkeys,
  trigger: triggerMotionHotkey,
}

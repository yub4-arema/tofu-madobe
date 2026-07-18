import type { MotionHotkeyChoice } from "./protocol"

const wsUrl = process.env.NEXT_PUBLIC_VTUBE_STUDIO_WS_URL ?? "ws://127.0.0.1:8001"
const pluginName = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_NAME ?? "tofu-madobe"
const pluginDeveloper = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_DEVELOPER ?? "tofu"
const tokenKey = "tofu-madobe:vtube-studio-token"

type Message = { requestID: string; messageType: string; data?: Record<string, unknown> }
type Hotkey = { name?: string; type?: string; file?: string; hotkeyID?: string }

function getMotionTag(hotkey: Hotkey) {
  const name = hotkey.name?.trim().normalize("NFKC")
  if (!name) return null
  const tag = name.replace(/\s+/g, "-").toLocaleLowerCase()
  return tag.length <= 64 && !tag.includes("[") && !tag.includes("]") && !/\s/u.test(tag) ? tag : null
}

function isUsableMotionHotkey(hotkey: Hotkey) {
  return Boolean(hotkey.hotkeyID) && hotkey.type === "TriggerAnimation" && Boolean(getMotionTag(hotkey))
}

class VTubeStudioClient {
  private socket: WebSocket | null = null
  private pending = new Map<string, { resolve: (message: Message) => void; reject: (error: Error) => void }>()
  private hotkeys = new Map<string, Hotkey>()

  private async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket
    const socket = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("VTube Studioへ接続できません。")), { once: true })
    })
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      const message = JSON.parse(event.data) as Message
      const request = this.pending.get(message.requestID)
      if (!request) return
      this.pending.delete(message.requestID)
      if (message.messageType === "APIError") request.reject(new Error(String(message.data?.message ?? "VTube Studio API error")))
      else request.resolve(message)
    })
    socket.addEventListener("close", () => {
      this.socket = null
      for (const request of this.pending.values()) request.reject(new Error("VTube Studioとの接続が切れました。"))
      this.pending.clear()
    })
    this.socket = socket
    return socket
  }

  private async request(messageType: string, data: Record<string, unknown>) {
    const socket = await this.connect()
    const requestID = crypto.randomUUID()
    const response = new Promise<Message>((resolve, reject) => {
      this.pending.set(requestID, { resolve, reject })
      window.setTimeout(() => {
        if (this.pending.delete(requestID)) reject(new Error(`${messageType}がタイムアウトしました。`))
      }, 8000)
    })
    socket.send(JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID, messageType, data }))
    return response
  }

  private async authenticate() {
    let token = localStorage.getItem(tokenKey)
    if (!token) {
      const response = await this.request("AuthenticationTokenRequest", { pluginName, pluginDeveloper })
      token = typeof response.data?.authenticationToken === "string" ? response.data.authenticationToken : null
      if (!token) throw new Error("VTube Studioの認証トークンを取得できません。")
      localStorage.setItem(tokenKey, token)
    }
    const response = await this.request("AuthenticationRequest", {
      pluginName,
      pluginDeveloper,
      authenticationToken: token,
    })
    if (response.data?.authenticated !== true) {
      localStorage.removeItem(tokenKey)
      throw new Error("VTube Studioの認証が拒否されました。")
    }
  }

  async prepare(): Promise<MotionHotkeyChoice[]> {
    await this.authenticate()
    const response = await this.request("HotkeysInCurrentModelRequest", {})
    const available = Array.isArray(response.data?.availableHotkeys) ? response.data.availableHotkeys as Hotkey[] : []
    const usable = available.filter(isUsableMotionHotkey)
    const counts = new Map<string, number>()
    for (const hotkey of usable) {
      const tag = getMotionTag(hotkey)
      if (!tag) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    this.hotkeys = new Map(
      usable.filter((hotkey) => counts.get(getMotionTag(hotkey) ?? "") === 1)
        .slice(0, 50)
        .flatMap((hotkey) => {
          const tag = getMotionTag(hotkey)
          return tag ? [[tag, hotkey] as const] : []
        })
    )
    if (!this.hotkeys.size) {
      throw new Error("VTube StudioにTriggerAnimation Hotkeyが見つかりません。")
    }
    console.info("[tofu-madobe] VTube Studio Hotkeys loaded", {
      tags: Array.from(this.hotkeys.keys()),
    })
    return Array.from(this.hotkeys, ([tag, hotkey]) => ({ tag, name: hotkey.name?.trim() || tag }))
  }

  async trigger(tag: string) {
    const hotkey = this.hotkeys.get(tag)
    if (!hotkey?.hotkeyID) throw new Error(`VTube Studioのモーションが見つかりません: ${tag}`)
    const response = await this.request("HotkeysInCurrentModelRequest", {})
    const current = (Array.isArray(response.data?.availableHotkeys) ? response.data.availableHotkeys as Hotkey[] : [])
      .find((candidate) => candidate.hotkeyID === hotkey.hotkeyID && getMotionTag(candidate) === tag && isUsableMotionHotkey(candidate))
    if (!current?.hotkeyID) {
      this.hotkeys.delete(tag)
      throw new Error(`VTube Studioのモーションが変更または削除されました: ${tag}`)
    }
    await this.request("HotkeyTriggerRequest", { hotkeyID: current.hotkeyID })
  }
}

export const vtubeStudio = new VTubeStudioClient()

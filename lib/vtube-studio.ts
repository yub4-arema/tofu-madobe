import type { VTubeHotkey } from "./protocol";
import { debugError, debugLog, debugWarn } from "./debug-log";

const url = process.env.NEXT_PUBLIC_VTUBE_STUDIO_WS_URL ?? "ws://127.0.0.1:8001";
const pluginName = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_NAME ?? "tofu-madobe";
const pluginDeveloper = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_DEVELOPER ?? "tofu";
const tokenKey = "tofu-madobe:vtube-studio-token";

type ApiResponse = { requestID?: string; messageType: string; data?: Record<string, unknown> };
type ApiHotkey = { hotkeyID?: unknown; name?: unknown; type?: unknown };
export type VTubeStudioState = {
  connected: boolean;
  hotkeys: VTubeHotkey[];
  error?: string;
};

class VTubeStudio {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private preparing?: Promise<void>;
  private authenticated = false;
  private pending = new Map<
    string,
    {
      resolve: (data: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();
  private hotkeys: VTubeHotkey[] = [];
  private listeners = new Set<(state: VTubeStudioState) => void>();
  private reconnectTimer?: number;

  private emit(state: VTubeStudioState) {
    debugLog("vts", "state emitted", {
      connected: state.connected,
      hotkeyCount: state.hotkeys.length,
      hotkeys: state.hotkeys,
      error: state.error,
      listenerCount: this.listeners.size,
    });
    for (const listener of this.listeners) listener(state);
  }

  private scheduleReconnect() {
    if (!this.listeners.size || this.reconnectTimer !== undefined) {
      debugLog("vts", "reconnect not scheduled", {
        listenerCount: this.listeners.size,
        alreadyScheduled: this.reconnectTimer !== undefined,
      });
      return;
    }
    debugLog("vts", "reconnect scheduled", { delayMs: 3000 });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.prepare().catch((error: unknown) => {
        debugError("vts", "reconnect preparation failed", error);
        this.emit({
          connected: false,
          hotkeys: [],
          error: error instanceof Error ? error.message : "VTube Studioへ接続できません。",
        });
        this.scheduleReconnect();
      });
    }, 3000);
  }

  private async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      debugLog("vts", "connect reused open socket");
      return this.socket;
    }
    if (this.connecting) {
      debugLog("vts", "connect joined in-flight attempt");
      return this.connecting;
    }
    debugLog("vts", "WebSocket connection started", { url });
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener(
        "open",
        () => {
          debugLog("vts", "WebSocket opened", { url });
          this.socket = socket;
          this.connecting = undefined;
          resolve(socket);
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          debugError("vts", "WebSocket connection error", `VTube Studioへ接続できません: ${url}`);
          this.connecting = undefined;
          reject(new Error(`VTube Studioへ接続できません: ${url}`));
        },
        { once: true },
      );
      socket.addEventListener("message", ({ data }) => this.receive(data));
      socket.addEventListener("close", () => {
        debugWarn("vts", "WebSocket closed", {
          wasCurrentSocket: this.socket === socket,
          pendingRequestCount: this.pending.size,
        });
        if (this.socket === socket) this.socket = undefined;
        this.connecting = undefined;
        this.preparing = undefined;
        this.authenticated = false;
        this.hotkeys = [];
        for (const pending of this.pending.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(new Error("VTube Studioとの接続が切れました。"));
        }
        this.pending.clear();
        this.emit({ connected: false, hotkeys: [] });
        this.scheduleReconnect();
      });
    });
    return this.connecting;
  }

  private receive(raw: unknown) {
    if (typeof raw !== "string") {
      debugWarn("vts", "non-text WebSocket message ignored", { rawType: typeof raw });
      return;
    }
    let response: ApiResponse;
    try {
      response = JSON.parse(raw) as ApiResponse;
    } catch (error) {
      debugError("vts", "WebSocket message JSON parse failed", error, { raw });
      return;
    }
    debugLog("vts", "WebSocket message received", { response });
    if (response.messageType === "ModelLoadedEvent") {
      debugLog("vts", "model loaded event received; refreshing hotkeys");
      void this.refreshHotkeys().catch((error: unknown) =>
        this.emit({
          connected: true,
          hotkeys: this.hotkeys,
          error: error instanceof Error ? error.message : "ホットキーを更新できません。",
        }),
      );
      return;
    }
    if (!response.requestID) {
      debugWarn("vts", "message ignored: no request ID", { response });
      return;
    }
    const pending = this.pending.get(response.requestID);
    if (!pending) {
      debugWarn("vts", "message ignored: request is no longer pending", {
        requestID: response.requestID,
        messageType: response.messageType,
      });
      return;
    }
    this.pending.delete(response.requestID);
    window.clearTimeout(pending.timer);
    if (response.messageType === "APIError") {
      debugWarn("vts", "API request returned an error", { response });
      pending.reject(
        new Error(
          typeof response.data?.message === "string"
            ? response.data.message
            : "VTube Studio API error",
        ),
      );
    } else {
      debugLog("vts", "API request resolved", {
        requestID: response.requestID,
        messageType: response.messageType,
      });
      pending.resolve(response.data ?? {});
    }
  }

  private async request(type: string, data: Record<string, unknown> = {}) {
    const socket = await this.connect();
    const requestID = crypto.randomUUID();
    const loggedData =
      "authenticationToken" in data ? { ...data, authenticationToken: "(redacted)" } : data;
    debugLog("vts", "API request sent", { requestID, type, data: loggedData });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestID);
        debugWarn("vts", "API request timed out", { requestID, type, timeoutMs: 8000 });
        reject(new Error(`VTube Studio request timed out: ${type}`));
      }, 8000);
      this.pending.set(requestID, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          apiName: "VTubeStudioPublicAPI",
          apiVersion: "1.0",
          requestID,
          messageType: type,
          data,
        }),
      );
    });
  }

  private async authenticate() {
    if (this.authenticated) {
      debugLog("vts", "authentication skipped: already authenticated");
      return;
    }
    const saved = localStorage.getItem(tokenKey);
    debugLog("vts", "authentication started", { hasSavedToken: !!saved });
    if (saved) {
      const authenticated = await this.request("AuthenticationRequest", {
        pluginName,
        pluginDeveloper,
        authenticationToken: saved,
      }).then((data) => data.authenticated === true);
      if (authenticated) {
        this.authenticated = true;
        debugLog("vts", "authenticated with saved token");
        return;
      }
      debugWarn("vts", "saved token rejected; requesting a new token");
    }
    const token = await this.request("AuthenticationTokenRequest", {
      pluginName,
      pluginDeveloper,
    }).then((data) => data.authenticationToken);
    if (typeof token !== "string") throw new Error("VTube Studioの認証トークンを取得できません。");
    localStorage.setItem(tokenKey, token);
    debugLog("vts", "new authentication token received and stored");
    const authenticated = await this.request("AuthenticationRequest", {
      pluginName,
      pluginDeveloper,
      authenticationToken: token,
    }).then((data) => data.authenticated);
    if (authenticated !== true) throw new Error("VTube Studio認証が拒否されました。");
    this.authenticated = true;
    debugLog("vts", "authenticated with new token");
  }

  private async refreshHotkeys() {
    debugLog("vts", "hotkey refresh started");
    const data = await this.request("HotkeysInCurrentModelRequest");
    const available = Array.isArray(data.availableHotkeys)
      ? (data.availableHotkeys as ApiHotkey[])
      : [];
    this.hotkeys = available.flatMap(({ hotkeyID, name, type }) =>
      typeof hotkeyID === "string" && typeof name === "string" && typeof type === "string"
        ? [{ id: hotkeyID, name, type }]
        : [],
    );
    debugLog("vts", "hotkey refresh completed", {
      count: this.hotkeys.length,
      hotkeys: this.hotkeys,
    });
    this.emit({ connected: true, hotkeys: this.hotkeys });
  }

  private prepare() {
    if (this.preparing) {
      debugLog("vts", "prepare joined in-flight attempt");
      return this.preparing;
    }
    debugLog("vts", "prepare started");
    this.preparing = (async () => {
      await this.authenticate();
      await this.request("EventSubscriptionRequest", {
        eventName: "ModelLoadedEvent",
        subscribe: true,
        config: {},
      });
      debugLog("vts", "ModelLoadedEvent subscription completed");
      await this.refreshHotkeys();
    })().finally(() => {
      debugLog("vts", "prepare settled");
      this.preparing = undefined;
    });
    return this.preparing;
  }

  watch(listener: (state: VTubeStudioState) => void) {
    this.listeners.add(listener);
    debugLog("vts", "watcher added", { listenerCount: this.listeners.size });
    listener({ connected: this.authenticated, hotkeys: this.hotkeys });
    void this.prepare().catch((error: unknown) => {
      if (!this.listeners.size) {
        debugLog("vts", "initial preparation cancellation ignored after watcher removal", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      debugError("vts", "initial preparation failed", error);
      this.emit({
        connected: false,
        hotkeys: [],
        error: error instanceof Error ? error.message : "VTube Studioへ接続できません。",
      });
      this.scheduleReconnect();
    });
    return () => {
      this.listeners.delete(listener);
      debugLog("vts", "watcher removed", { listenerCount: this.listeners.size });
      if (this.listeners.size) return;
      if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.socket?.close();
    };
  }

  async trigger(id: string) {
    debugLog("vts", "hotkey trigger requested", { id, cachedHotkeyCount: this.hotkeys.length });
    if (!this.hotkeys.some((hotkey) => hotkey.id === id))
      throw new Error(`現在のモデルにホットキーがありません: ${id}`);
    await this.request("HotkeyTriggerRequest", { hotkeyID: id });
    debugLog("vts", "hotkey trigger completed", { id });
  }
}

const client = new VTubeStudio();
export const watchVTubeStudio = (listener: (state: VTubeStudioState) => void) =>
  client.watch(listener);
export const triggerVTubeHotkey = (id: string) => client.trigger(id);

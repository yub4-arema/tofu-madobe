import type { MotionHotkeyChoice } from "./protocol";

const url = process.env.NEXT_PUBLIC_VTUBE_STUDIO_WS_URL ?? "ws://127.0.0.1:8001";
const pluginName = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_NAME ?? "tofu-madobe";
const pluginDeveloper = process.env.NEXT_PUBLIC_VTUBE_STUDIO_PLUGIN_DEVELOPER ?? "tofu";
const tokenKey = "tofu-madobe:vtube-studio-token";

type Response = { requestID: string; messageType: string; data?: Record<string, unknown> };
type Hotkey = { hotkeyID?: string; name?: string; type?: string; file?: string };

class VTubeStudio {
  private socket?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private pending = new Map<
    string,
    {
      resolve: (data: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();
  private hotkeys = new Map<string, string>();

  private async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener(
        "open",
        () => {
          this.socket = socket;
          resolve(socket);
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          this.connecting = undefined;
          reject(new Error(`VTube Studioへ接続できません: ${url}`));
        },
        { once: true },
      );
      socket.addEventListener("message", ({ data }) => this.receive(data));
      socket.addEventListener("close", () => {
        this.socket = undefined;
        this.connecting = undefined;
      });
    });
    return this.connecting;
  }

  private receive(raw: unknown) {
    if (typeof raw !== "string") return;
    let response: Response;
    try {
      response = JSON.parse(raw) as Response;
    } catch {
      return;
    }
    const pending = this.pending.get(response.requestID);
    if (!pending) return;
    this.pending.delete(response.requestID);
    clearTimeout(pending.timer);
    if (response.messageType === "APIError")
      pending.reject(
        new Error(
          typeof response.data?.message === "string"
            ? response.data.message
            : "VTube Studio API error",
        ),
      );
    else pending.resolve(response.data ?? {});
  }

  private async request(type: string, data: Record<string, unknown> = {}) {
    const socket = await this.connect();
    const requestID = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestID);
        reject(new Error(`VTube Studio request timed out: ${type}`));
      }, 8_000);
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
    const saved = localStorage.getItem(tokenKey);
    if (
      saved &&
      (await this.request("AuthenticationRequest", {
        pluginName,
        pluginDeveloper,
        authenticationToken: saved,
      }).then((data) => data.authenticated === true))
    )
      return;
    const token = await this.request("AuthenticationTokenRequest", {
      pluginName,
      pluginDeveloper,
    }).then((data) => data.authenticationToken);
    if (typeof token !== "string") throw new Error("VTube Studioの認証トークンを取得できません。");
    localStorage.setItem(tokenKey, token);
    const authenticated = await this.request("AuthenticationRequest", {
      pluginName,
      pluginDeveloper,
      authenticationToken: token,
    }).then((data) => data.authenticated);
    if (authenticated !== true) throw new Error("VTube Studio認証が拒否されました。");
  }

  async prepare() {
    await this.authenticate();
    const available =
      ((await this.request("HotkeysInCurrentModelRequest")).availableHotkeys as
        | Hotkey[]
        | undefined) ?? [];
    const choices = available.flatMap((hotkey) => {
      const tag = hotkey.name?.trim().toLowerCase();
      return hotkey.hotkeyID &&
        tag &&
        /^[a-z0-9_-]{1,64}$/.test(tag) &&
        hotkey.type === "TriggerAnimation" &&
        hotkey.file?.endsWith(".motion3.json")
        ? [{ tag, name: hotkey.name ?? tag, id: hotkey.hotkeyID }]
        : [];
    });
    this.hotkeys = new Map(choices.map(({ tag, id }) => [tag, id]));
    return choices.map(({ tag, name }) => ({ tag, name })) satisfies MotionHotkeyChoice[];
  }

  async trigger(tag: string) {
    const id = this.hotkeys.get(tag);
    if (!id) throw new Error(`VTube Studio motion tag is not available: ${tag}`);
    await this.request("HotkeyTriggerRequest", { hotkeyID: id });
  }
}

const client = new VTubeStudio();
export const prepareMotionHotkeys = () => client.prepare();
export const triggerMotionHotkey = (tag: string) => client.trigger(tag);

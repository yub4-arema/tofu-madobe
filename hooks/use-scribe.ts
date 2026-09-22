"use client";

import {
  CommitStrategy,
  RealtimeEvents,
  Scribe,
  type RealtimeConnection,
} from "@elevenlabs/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { debugError, debugLog, debugWarn } from "@/lib/debug-log";

type Status = "stopped" | "connecting" | "connected";

export function useScribe(options: {
  onPartial: (text: string) => void;
  onCommitted: (text: string) => void;
}) {
  const callbacks = useRef(options);
  const connection = useRef<RealtimeConnection | null>(null);
  const running = useRef(false);
  const enabled = useRef(true);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectDelay = useRef(1000);
  const connectionAttempt = useRef(0);
  const [status, setStatus] = useState<Status>("stopped");
  const [error, setError] = useState<string | null>(null);
  callbacks.current = options;

  const connect = useCallback(async () => {
    if (!running.current || connection.current) {
      debugLog("scribe", "connect skipped", {
        running: running.current,
        hasConnection: !!connection.current,
      });
      return;
    }
    const attempt = ++connectionAttempt.current;
    const scope = `scribe:${attempt}`;
    debugLog(scope, "connection attempt started", {
      enabled: enabled.current,
      reconnectDelayMs: reconnectDelay.current,
    });
    setStatus("connecting");
    try {
      debugLog(scope, "requesting single-use token");
      const response = await fetch("/api/scribe/token", { method: "POST" });
      const raw = await response.text();
      const data = (await Promise.resolve(raw)
        .then((body) => JSON.parse(body))
        .catch(() => null)) as {
        token?: string;
        error?: { message?: string };
      } | null;
      debugLog(scope, "token response received", {
        status: response.status,
        ok: response.ok,
        hasToken: !!data?.token,
        contentType: response.headers.get("content-type"),
        errorBodyPreview: response.ok ? undefined : raw.slice(0, 500),
      });
      if (!response.ok || !data?.token)
        throw new Error(
          data?.error?.message ?? `ScribeトークンAPIがHTTP ${response.status}を返しました。`,
        );
      if (!running.current) {
        debugWarn(scope, "token discarded because Scribe was stopped");
        return;
      }
      debugLog(scope, "opening realtime connection", {
        modelId: "scribe_v2_realtime",
        languageCode: "ja",
        commitStrategy: String(CommitStrategy.VAD),
      });
      const current = Scribe.connect({
        token: data.token,
        modelId: "scribe_v2_realtime",
        languageCode: "ja",
        commitStrategy: CommitStrategy.VAD,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      connection.current = current;
      current.on(RealtimeEvents.OPEN, () => {
        debugLog(scope, "connection opened", { enabled: enabled.current });
        reconnectDelay.current = 1000;
        setStatus("connected");
        setError(null);
        if (!enabled.current)
          try {
            current.mute();
          } catch (error) {
            debugWarn(scope, "mute after open deferred", {
              error: error instanceof Error ? error.message : String(error),
            });
            // The microphone track can finish attaching immediately after OPEN.
          }
      });
      current.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
        const trimmed = text.trim();
        debugLog(scope, "partial transcript", { raw: text, trimmed });
        callbacks.current.onPartial(trimmed);
      });
      current.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
        const trimmed = text.trim();
        debugLog(scope, "committed transcript", { raw: text, trimmed });
        callbacks.current.onCommitted(trimmed);
      });
      current.on(RealtimeEvents.ERROR, ({ error: message }) => {
        debugError(scope, "realtime error", message);
        setError(message);
      });
      current.on(RealtimeEvents.CLOSE, () => {
        debugWarn(scope, "connection closed", {
          isCurrentConnection: connection.current === current,
          running: running.current,
        });
        if (connection.current === current) connection.current = null;
        if (!running.current) {
          setStatus("stopped");
          return;
        }
        setStatus("connecting");
        debugLog(scope, "reconnect scheduled", { delayMs: reconnectDelay.current });
        reconnectTimer.current = window.setTimeout(() => {
          reconnectTimer.current = null;
          void connect();
        }, reconnectDelay.current);
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 10_000);
      });
    } catch (caught) {
      debugWarn(scope, "connection attempt failed; retrying", {
        running: running.current,
        reconnectDelayMs: reconnectDelay.current,
        error:
          caught instanceof Error
            ? { name: caught.name, message: caught.message, stack: caught.stack }
            : String(caught),
      });
      setError(caught instanceof Error ? caught.message : "Scribeへ接続できません。");
      setStatus(running.current ? "connecting" : "stopped");
      if (running.current) {
        debugLog(scope, "reconnect scheduled after failure", {
          delayMs: reconnectDelay.current,
        });
        reconnectTimer.current = window.setTimeout(() => {
          reconnectTimer.current = null;
          void connect();
        }, reconnectDelay.current);
      }
      reconnectDelay.current = Math.min(reconnectDelay.current * 2, 10_000);
    }
  }, []);

  const start = useCallback(async () => {
    if (running.current) {
      debugLog("scribe", "start skipped: already running");
      return;
    }
    debugLog("scribe", "start requested", { enabled: enabled.current });
    running.current = true;
    reconnectDelay.current = 1000;
    await connect();
    debugLog("scribe", "start call completed", { status: "connection attempt dispatched" });
  }, [connect]);

  const stop = useCallback(() => {
    debugWarn("scribe", "stop requested", {
      hasConnection: !!connection.current,
      hasReconnectTimer: reconnectTimer.current !== null,
    });
    running.current = false;
    if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    connection.current?.close();
    connection.current = null;
    setStatus("stopped");
    debugLog("scribe", "stop completed");
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    debugLog("scribe", "microphone enabled state requested", {
      previous: enabled.current,
      current: value,
      hasConnection: !!connection.current,
    });
    enabled.current = value;
    try {
      if (value) connection.current?.unmute();
      else connection.current?.mute();
      debugLog("scribe", value ? "connection unmuted" : "connection muted");
    } catch (error) {
      debugWarn("scribe", value ? "unmute deferred" : "mute deferred", {
        error: error instanceof Error ? error.message : String(error),
      });
      // The SDK attaches the microphone track asynchronously; OPEN retries the desired state.
    }
  }, []);

  useEffect(() => stop, [stop]);
  return { start, stop, setEnabled, status, error, clearError: () => setError(null) };
}

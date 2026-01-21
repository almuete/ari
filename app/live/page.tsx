"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type LogItem = { t: number; level: "info" | "warn" | "error"; msg: string };

const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"; // :contentReference[oaicite:2]{index=2}

const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"; // :contentReference[oaicite:3]{index=3}

// Per docs: input 16-bit PCM, 16kHz mono; output audio 24kHz. :contentReference[oaicite:4]{index=4}
const SEND_SAMPLE_RATE = 16000;
const RECEIVE_SAMPLE_RATE = 24000;

// Send ~20ms frames (16000 * 0.02 = 320 samples)
const FRAME_SAMPLES = 320;

function base64FromArrayBuffer(buf: ArrayBuffer): string {
  // Browser-safe base64 encoding
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function arrayBufferFromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function clamp16BitPCM(x: number) {
  const v = Math.max(-1, Math.min(1, x));
  return v < 0 ? v * 0x8000 : v * 0x7fff;
}

/**
 * Very small linear resampler float32 -> float32
 * (Good enough for voice; you can upgrade later.)
 */
function resampleFloat32(
  input: Float32Array,
  inRate: number,
  outRate: number
): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function floatToInt16PCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = clamp16BitPCM(input[i]);
  return out;
}

export default function LiveMicPage() {
  const [apiKey, setApiKey] = useState("AIzaSyDC8vfHRXpOxuFfTAdIy6fVblJTO2A7");
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");

  const [logs, setLogs] = useState<LogItem[]>([]);

  const wsRef = useRef<WebSocket | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // Buffering for sending
  const sendBufRef = useRef<Float32Array[]>([]);
  const sendBufSamplesRef = useRef(0);

  // Output playback
  const playCtxRef = useRef<AudioContext | null>(null);
  const playTimeRef = useRef<number>(0);

  const log = (level: LogItem["level"], msg: string) => {
    setLogs((prev) => [{ t: Date.now(), level, msg }, ...prev].slice(0, 200));
  };

  const wsUrl = useMemo(() => {
    const key = apiKey.trim();
    if (!key) return "";
    // Common pattern for Google APIs: key in query string for WS.
    return `${WS_ENDPOINT}?key=${encodeURIComponent(key)}`;
  }, [apiKey]);

  const cleanupAudio = async () => {
    setStreaming(false);

    try {
      processorRef.current?.disconnect();
    } catch {}
    try {
      sourceNodeRef.current?.disconnect();
    } catch {}

    processorRef.current = null;
    sourceNodeRef.current = null;

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
  };

  const cleanupWs = () => {
    setConnected(false);
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
  };

  const fullCleanup = async () => {
    await cleanupAudio();
    cleanupWs();

    // stop playback context
    if (playCtxRef.current) {
      try {
        await playCtxRef.current.close();
      } catch {}
      playCtxRef.current = null;
      playTimeRef.current = 0;
    }
  };

  useEffect(() => {
    return () => {
      void fullCleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = () => {
    if (!wsUrl) {
      log("warn", "Paste an API key first.");
      return;
    }
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      log("info", "WebSocket already open/connecting.");
      return;
    }

    log("info", "Connecting WebSocket…");
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      log("info", "WebSocket open. Sending setup…");
      setConnected(true);

      // Initial setup message (first message on the socket). :contentReference[oaicite:5]{index=5}
      const setupMsg = {
        setup: {
          model: MODEL,
          generation_config: {
            response_modalities: ["AUDIO"],
          },
          system_instruction: {
            role: "system",
            parts: [{ text: "You are a helpful and friendly AI assistant." }],
          },
        },
      };      

      ws.send(JSON.stringify(setupMsg));
    };

    ws.onclose = (ev) => {
      log("warn", `WebSocket closed (${ev.code}) ${ev.reason || ""}`.trim());
      setConnected(false);
      setStreaming(false);
    };

    ws.onerror = () => {
      log("error", "WebSocket error.");
    };

    ws.onmessage = async (evt) => {
      try {
        const data = typeof evt.data === "string" ? evt.data : await (evt.data as Blob).text();
        const msg = JSON.parse(data);

        // Input transcription (sent independently; ordering not guaranteed). :contentReference[oaicite:8]{index=8}
        if (msg.inputTranscription?.text) {
          setInputTranscript(msg.inputTranscription.text);
        }

        // Output transcription (sent independently; ordering not guaranteed). :contentReference[oaicite:9]{index=9}
        if (msg.outputTranscription?.text) {
          setOutputTranscript(msg.outputTranscription.text);
        }

        // Server content
        if (msg.serverContent?.modelTurn?.parts?.length) {
          for (const part of msg.serverContent.modelTurn.parts) {
            // Some SDKs use inlineData / inline_data naming; be defensive.
            const inline = part.inlineData ?? part.inline_data ?? part.inline_data?.inlineData ?? part.inlineData;
            if (inline?.data && inline?.mimeType) {
              const mime: string = inline.mimeType;

              // Audio blobs are base64. :contentReference[oaicite:10]{index=10}
              if (mime.startsWith("audio/pcm")) {
                await playPcmBase64(inline.data, mime);
              }
            }

            if (part.text) {
              // If the model emits text parts too (depends on config), append
              setOutputTranscript((prev) => (prev ? prev + "\n" : "") + part.text);
            }
          }
        }

        if (msg.serverContent?.interrupted) {
          // If you’re buffering playback, you’d clear the queue here. :contentReference[oaicite:11]{index=11}
          log("info", "Model interrupted (barge-in).");
        }
      } catch (e: any) {
        log("error", `Failed to parse message: ${e?.message || String(e)}`);
      }
    };
  };

  const disconnect = async () => {
    await fullCleanup();
    log("info", "Disconnected.");
  };

  const sendAudioFrame = (pcm16: Int16Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Blob: { data: base64, mimeType: string } :contentReference[oaicite:12]{index=12}
    const b64 = base64FromArrayBuffer(pcm16.buffer);

    const msg = {
      realtimeInput: {
        audio: {
          data: b64,
          mimeType: `audio/pcm;rate=${SEND_SAMPLE_RATE}`,
        },
      },
    };

    ws.send(JSON.stringify(msg));
  };

  const startMic = async () => {
    if (!connected) {
      log("warn", "Connect first.");
      return;
    }
    if (streaming) {
      log("info", "Mic already streaming.");
      return;
    }

    // Create playback context lazily (some browsers require user gesture).
    if (!playCtxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: RECEIVE_SAMPLE_RATE,
      });
      playCtxRef.current = ctx;
      playTimeRef.current = ctx.currentTime;
    }

    try {
      log("info", "Requesting microphone permission…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      micStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx(); // input context (device sample rate)
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      // ScriptProcessorNode is deprecated but widely supported and simplest for a single page demo.
      // If you want, we can upgrade this to AudioWorklet next.
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      // reset send buffers
      sendBufRef.current = [];
      sendBufSamplesRef.current = 0;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const floatChunk = new Float32Array(input); // copy

        // Resample to 16kHz mono float32, then convert to int16 PCM. :contentReference[oaicite:13]{index=13}
        const resampled = resampleFloat32(floatChunk, audioCtx.sampleRate, SEND_SAMPLE_RATE);

        // accumulate to fixed frame size for smoother WS sending
        sendBufRef.current.push(resampled);
        sendBufSamplesRef.current += resampled.length;

        while (sendBufSamplesRef.current >= FRAME_SAMPLES) {
          const frame = new Float32Array(FRAME_SAMPLES);
          let written = 0;

          while (written < FRAME_SAMPLES && sendBufRef.current.length) {
            const head = sendBufRef.current[0];
            const need = FRAME_SAMPLES - written;

            if (head.length <= need) {
              frame.set(head, written);
              written += head.length;
              sendBufRef.current.shift();
            } else {
              frame.set(head.subarray(0, need), written);
              written += need;
              sendBufRef.current[0] = head.subarray(need);
            }
          }

          sendBufSamplesRef.current -= FRAME_SAMPLES;

          const pcm16 = floatToInt16PCM(frame);
          sendAudioFrame(pcm16);
        }
      };

      setStreaming(true);
      log("info", "Mic streaming started. Speak!");
    } catch (e: any) {
      log("error", `Mic start failed: ${e?.message || String(e)}`);
      await cleanupAudio();
    }
  };

  const stopMic = async () => {
    await cleanupAudio();

    // Inform server audio stream ended (optional). :contentReference[oaicite:14]{index=14}
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }

    log("info", "Mic streaming stopped.");
  };

  const playPcmBase64 = async (b64: string, mimeType: string) => {
    // Expect: audio/pcm;rate=24000 (per docs). :contentReference[oaicite:15]{index=15}
    const rateMatch = /rate=(\d+)/.exec(mimeType);
    const rate = rateMatch ? Number(rateMatch[1]) : RECEIVE_SAMPLE_RATE;

    const ctx = playCtxRef.current;
    if (!ctx) return;

    const buf = arrayBufferFromBase64(b64);
    const int16 = new Int16Array(buf);

    // Convert int16 -> float32
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x8000;
    }

    // If server rate differs, resample for playback context rate
    const toPlay = resampleFloat32(float32, rate, ctx.sampleRate);

    const audioBuffer = ctx.createBuffer(1, toPlay.length, ctx.sampleRate);
    audioBuffer.getChannelData(0).set(toPlay);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Schedule sequentially to avoid jitter
    const now = ctx.currentTime;
    const startAt = Math.max(now, playTimeRef.current);
    source.start(startAt);
    playTimeRef.current = startAt + audioBuffer.duration;
  };

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Gemini Live — Mic Stream (Next.js)</h1>
      <p style={{ marginTop: 0, opacity: 0.8 }}>
        Sends <b>16-bit PCM / 16kHz / mono</b> from your mic and plays back model audio (typically <b>24kHz</b>). :contentReference[oaicite:16]index=16
      </p>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr", marginTop: 12 }}>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, opacity: 0.75, minWidth: 70 }}>API key</label>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste Gemini API key (dev only)"
              style={{
                flex: "1 1 340px",
                padding: "8px 10px",
                border: "1px solid #e5e7eb",
                borderRadius: 10,
              }}
              type="password"
              autoComplete="off"
            />
            <button
              onClick={connect}
              disabled={!apiKey.trim() || connected}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: connected ? "#f3f4f6" : "white",
                cursor: connected ? "not-allowed" : "pointer",
              }}
            >
              {connected ? "Connected" : "Connect"}
            </button>

            <button
              onClick={() => void disconnect()}
              style={{
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: "white",
              }}
            >
              Disconnect
            </button>

            <span style={{ fontSize: 12, opacity: 0.7 }}>
              Model: <code>{MODEL}</code> :contentReference[oaicite:17]index=17
            </span>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => void startMic()}
              disabled={!connected || streaming}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: streaming ? "#f3f4f6" : "white",
                cursor: !connected || streaming ? "not-allowed" : "pointer",
              }}
            >
              Start Mic
            </button>
            <button
              onClick={() => void stopMic()}
              disabled={!streaming}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #e5e7eb",
                background: !streaming ? "#f3f4f6" : "white",
                cursor: !streaming ? "not-allowed" : "pointer",
              }}
            >
              Stop Mic
            </button>

            <span style={{ fontSize: 12, opacity: 0.7, alignSelf: "center" }}>
              Status:{" "}
              <b>
                {connected ? (streaming ? "Streaming" : "Connected") : "Disconnected"}
              </b>
            </span>
          </div>

          <p style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            For production, use <b>Ephemeral Tokens</b> instead of exposing API keys in the browser. :contentReference[oaicite:18]index=18
          </p>
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, minHeight: 180 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Input transcript</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{inputTranscript || "—"}</pre>
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, minHeight: 180 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Output transcript</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{outputTranscript || "—"}</pre>
          </div>
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Logs</div>
            <button
              onClick={() => setLogs([])}
              style={{ padding: "6px 10px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white" }}
            >
              Clear
            </button>
          </div>
          <div style={{ marginTop: 8, maxHeight: 220, overflow: "auto" }}>
            {logs.length === 0 ? (
              <div style={{ fontSize: 12, opacity: 0.6 }}>—</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {logs.map((l) => (
                  <li key={l.t + l.msg} style={{ fontSize: 12, margin: "6px 0" }}>
                    <span style={{ opacity: 0.6 }}>
                      {new Date(l.t).toLocaleTimeString()}
                    </span>{" "}
                    <b style={{ marginRight: 6 }}>{l.level.toUpperCase()}</b>
                    <span>{l.msg}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

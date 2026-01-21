"use client";

import VoiceWave from "@/components/speech/VoiceWave";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { BiRefresh } from "react-icons/bi";

type LogItem = { t: number; level: "info" | "warn" | "error"; msg: string };

// Ephemeral tokens are supported in v1alpha + constrained endpoint.
const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

const MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";

// Per docs: input 16-bit PCM, 16kHz mono; output audio typically 24kHz.
const SEND_SAMPLE_RATE = 16000;
const RECEIVE_SAMPLE_RATE = 24000;

// Send ~20ms frames (16000 * 0.02 = 320 samples)
const FRAME_SAMPLES = 320;

function getBossGreeting(now = new Date()): string {
  const h = now.getHours();
  const timeOfDay =
    h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night";

  const variants = [
    // Classic
    `Good ${timeOfDay}, boss.`,
    `Welcome back, boss. Good ${timeOfDay}.`,
    `Good ${timeOfDay}, boss. Ready when you are.`,

    // Friendly & warm
    `Hope you're having a great ${timeOfDay}, boss.`,
    `Nice to see you, boss. Good ${timeOfDay}.`,
    `Hey boss, good ${timeOfDay}!`,

    // Professional & confident
    `All set, boss. Good ${timeOfDay}.`,
    `Good ${timeOfDay}, boss. Everything is ready.`,
    `Standing by, boss. Have a great ${timeOfDay}.`,

    // Light motivation
    `Let’s make this ${timeOfDay} productive, boss.`,
    `Another strong ${timeOfDay} ahead, boss.`,
    `Ready to win this ${timeOfDay}, boss?`,

    // Late-night friendly
    `Still going strong tonight, boss.`,
    `Good night, boss. Let me know if you need anything.`,
  ];

  return variants[Math.floor(Math.random() * variants.length)]!;
}


function base64FromArrayBuffer(buf: ArrayBufferLike): string {
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
 * Very small linear resampler float32 -> float32.
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

async function fetchEphemeralToken(): Promise<string> {
  const res = await fetch("/api/gemini/ephemeral-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) {
    throw new Error(data.error || "Failed to create ephemeral token.");
  }
  return data.token;
}

export default function GeminiLiveMic() {
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");

  const [logs, setLogs] = useState<LogItem[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const lastInputTranscriptRef = useRef<string>("");
  const lastOutputTranscriptRef = useRef<string>("");
  const outputHistoryRef = useRef<string[]>([]);

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

  const log = useCallback((level: LogItem["level"], msg: string) => {
    setLogs((prev) => [{ t: Date.now(), level, msg }, ...prev].slice(0, 200));
  }, []);

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

  const connect = useCallback(async () => {
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      log("info", "WebSocket already open/connecting.");
      return;
    }

    try {
      log("info", "Requesting ephemeral token…");
      const token = await fetchEphemeralToken();
      const wsUrl = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`;

      log("info", "Connecting WebSocket…");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        log("info", "WebSocket open. Sending setup…");
        setConnected(true);

        const setupMsg = {
          setup: {
            model: MODEL,
            generation_config: {
              response_modalities: ["AUDIO"],
            },
            // Opt-in: receive transcriptions for input and output audio.
            input_audio_transcription: {},
            output_audio_transcription: {},
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
          const data =
            typeof evt.data === "string"
              ? evt.data
              : await (evt.data as Blob).text();
          const msg = JSON.parse(data);

          const readFirstString = (root: unknown, paths: string[][]): string | null => {
            for (const path of paths) {
              let cur: unknown = root;
              for (const key of path) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                cur = (cur as any)?.[key];
              }
              if (typeof cur === "string" && cur.trim().length) return cur;
            }
            return null;
          };

          // Transcriptions are opt-in via setup config and may arrive with different
          // casing/nesting depending on endpoint/client.
          const inputText = readFirstString(msg, [
            ["inputTranscription", "text"],
            ["input_transcription", "text"],
            ["serverContent", "inputTranscription", "text"],
            ["serverContent", "input_transcription", "text"],
            ["server_content", "inputTranscription", "text"],
            ["server_content", "input_transcription", "text"],
          ]);
          if (inputText && inputText !== lastInputTranscriptRef.current) {
            lastInputTranscriptRef.current = inputText;
            log("info", `[ME] ${inputText}`);
          }

          const outputText = readFirstString(msg, [
            ["outputTranscription", "text"],
            ["output_transcription", "text"],
            ["serverContent", "outputTranscription", "text"],
            ["serverContent", "output_transcription", "text"],
            ["server_content", "outputTranscription", "text"],
            ["server_content", "output_transcription", "text"],
          ]);
          // Prefer official output audio transcription when present.
          // These can stream incrementally, so keep a history of completed-ish messages
          // and also log every update we receive.
          if (outputText && outputText !== lastOutputTranscriptRef.current) {
            log("info", `[ARI] ${outputText}`);

            const prev = lastOutputTranscriptRef.current;
            const isContinuation =
              !prev ||
              outputText.startsWith(prev) ||
              prev.startsWith(outputText);

            // Heuristic: if the new text is not a continuation of the previous text,
            // treat the previous as a completed response and store it.
            if (prev && !isContinuation) {
              const lastStored = outputHistoryRef.current.at(-1);
              if (prev !== lastStored) outputHistoryRef.current.push(prev);
            }

            lastOutputTranscriptRef.current = outputText;

            const history = outputHistoryRef.current.join("\n\n");
            setOutputTranscript(history ? `${history}\n\n${outputText}` : outputText);
          }

          if (msg.serverContent?.modelTurn?.parts?.length) {
            // Fallback: derive the AI text-only response from the model's turn parts.
            // We intentionally do NOT append; we replace with the latest model turn so the UI
            // shows only the AI response (and avoids duplicating partials).
            if (!outputText) {
              const combined = msg.serverContent.modelTurn.parts
                .map((p: unknown) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const t = (p as any)?.text;
                  return typeof t === "string" ? t : "";
                })
                .join("")
                .trim();
              
              if (combined && combined !== lastOutputTranscriptRef.current) {
                //log("info", `[AI output text] ${combined}`);

                const prev = lastOutputTranscriptRef.current;
                const isContinuation =
                  !prev ||
                  combined.startsWith(prev) ||
                  prev.startsWith(combined);
                if (prev && !isContinuation) {
                  const lastStored = outputHistoryRef.current.at(-1);
                  if (prev !== lastStored) outputHistoryRef.current.push(prev);
                }

                lastOutputTranscriptRef.current = combined;
                const history = outputHistoryRef.current.join("\n\n");
                setOutputTranscript(history ? `${history}\n\n${combined}` : combined);
              }
            }

            for (const part of msg.serverContent.modelTurn.parts) {
              const inline =
                part.inlineData ??
                part.inline_data ??
                part.inline_data?.inlineData ??
                part.inlineData;

              if (inline?.data && inline?.mimeType) {
                const mime: string = inline.mimeType;
                if (mime.startsWith("audio/pcm")) {
                  await playPcmBase64(inline.data, mime);
                }
              }
            }
          }

          if (msg.serverContent?.interrupted) {
            log("info", "Model interrupted (barge-in).");
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          log("error", `Failed to parse message: ${message}`);
        }
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", message);
      cleanupWs();
    }
  }, [log]);

  // Auto-connect on mount (so you don't have to click "Connect").
  useEffect(() => {
    void connect();
  }, [connect]);

  const disconnect = async () => {
    await fullCleanup();
    log("info", "Disconnected.");
  };

  const sendUserText = (text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log("warn", "WebSocket not ready to send text.");
      return;
    }

    // Ask the model to respond in audio (configured via setup response_modalities).
    // This is NOT browser speech synthesis—it's Gemini generating audio.
    const msg = {
      clientContent: {
        turns: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      },
    };

    ws.send(JSON.stringify(msg));
  };

  const sendAudioFrame = (pcm16: Int16Array) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

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

    if (!playCtxRef.current) {
      const ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)({
        sampleRate: RECEIVE_SAMPLE_RATE,
      });
      playCtxRef.current = ctx;
      playTimeRef.current = ctx.currentTime;
    }

    try {
      // Ensure audio playback is allowed (user gesture happens here).
      if (playCtxRef.current?.state === "suspended") {
        await playCtxRef.current.resume();
      }

      // Trigger an AI greeting right when the user starts the mic.
      // (This will come back as streamed audio that you can hear.)
      const greeting = getBossGreeting();
      log("info", `[ME] (greet) ${greeting}`);
      sendUserText(
        `Say exactly one short greeting sentence to me in a warm tone: "${greeting}"`
      );

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

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      sendBufRef.current = [];
      sendBufSamplesRef.current = 0;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const floatChunk = new Float32Array(input);

        const resampled = resampleFloat32(
          floatChunk,
          audioCtx.sampleRate,
          SEND_SAMPLE_RATE
        );

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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", `Mic start failed: ${message}`);
      await cleanupAudio();
    }
  };

  const stopMic = async () => {
    await cleanupAudio();

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }

    log("info", "Mic streaming stopped.");
  };

  const playPcmBase64 = async (b64: string, mimeType: string) => {
    const rateMatch = /rate=(\d+)/.exec(mimeType);
    const rate = rateMatch ? Number(rateMatch[1]) : RECEIVE_SAMPLE_RATE;

    const ctx = playCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // If resume fails (e.g. no user gesture yet), we'll still decode but playback may be muted.
      }
    }

    const buf = arrayBufferFromBase64(b64);
    const int16 = new Int16Array(buf);

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x8000;
    }

    const toPlay = resampleFloat32(float32, rate, ctx.sampleRate);

    const audioBuffer = ctx.createBuffer(1, toPlay.length, ctx.sampleRate);
    audioBuffer.getChannelData(0).set(toPlay);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, playTimeRef.current);
    source.start(startAt);
    playTimeRef.current = startAt + audioBuffer.duration;
  };

  return (
    <div>
      <div className="relative ">
          <div className="flex flex-col items-center gap-2">
            <button
              onClick={streaming ? () => void stopMic() : () => void startMic()}
              className="cursor-pointer"
              aria-label={streaming ? "Stop microphone" : "Start microphone"}
            >
              <VoiceWave
                active={true}
                color={streaming ? "#FF9500" : "green"}
                glow
                sensitivity={8}
                size={320}
                className="rounded-full"
              />
            </button>

            <span className="text-sm text-gray-500">
              {connected ? (streaming ? "Streaming" : "") : ""}
            </span>
          </div>

        <div className="relative">
          
          <div className="border border-gray-200 rounded-md p-2">
            {logs.length === 0 ? (
              <div>—</div>
            ) : (
              <ul className="overflow-y-auto max-h-[200px]">
                {logs.map((l) => (
                  <li key={l.t + l.msg} className="text-sm text-gray-500 text-left">
                    <span>
                      {new Date(l.t).toLocaleTimeString()}
                    </span>{" "}
                    <span>{l.msg}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="text-right absolute -top-2 -right-2 ">
            <button
              onClick={() => setLogs([])}
              className="cursor-pointer text-right bg-white rounded-full p-2 border border-gray-200"
            >
              <BiRefresh className="text-2xl" />
              
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


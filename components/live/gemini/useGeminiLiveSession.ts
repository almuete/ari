import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_SYSTEM_INSTRUCTION_TEXT,
  FRAME_SAMPLES,
  MAPS_FUNCTION_DECLARATIONS,
  MODEL,
  RECEIVE_SAMPLE_RATE,
  SEND_SAMPLE_RATE,
  STOP_SEQUENCES,
  WS_ENDPOINT,
  createStopSequenceRegex,
} from "./constants";
import { arrayBufferFromBase64, base64FromArrayBuffer, floatToInt16PCM, resampleFloat32 } from "./audio";
import { fetchEphemeralToken } from "./net";
import { extractFunctionCalls, readFirstString } from "./message";
import { runGeminiTool } from "./tools";
import type { GeminiFunctionCall, LogItem } from "./types";
import { getBossGreeting } from "./greeting";

export type UseGeminiLiveSessionOptions = {
  autoConnect?: boolean;
};

export function useGeminiLiveSession(options: UseGeminiLiveSessionOptions = {}) {
  const { autoConnect = true } = options;

  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");

  const [logs, setLogs] = useState<LogItem[]>([]);

  const stopSequenceRegexRef = useRef<RegExp>(createStopSequenceRegex());

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

  const clearLogs = useCallback(() => setLogs([]), []);

  const cleanupAudio = useCallback(async () => {
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
  }, []);

  const cleanupWs = useCallback(() => {
    setConnected(false);
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
  }, []);

  const fullCleanup = useCallback(async () => {
    await cleanupAudio();
    cleanupWs();

    if (playCtxRef.current) {
      try {
        await playCtxRef.current.close();
      } catch {}
      playCtxRef.current = null;
      playTimeRef.current = 0;
    }
  }, [cleanupAudio, cleanupWs]);

  useEffect(() => {
    return () => {
      void fullCleanup();
    };
  }, [fullCleanup]);

  const sendUserText = useCallback(
    (text: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        log("warn", "WebSocket not ready to send text.");
        return;
      }

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
    },
    [log]
  );

  const sendAudioFrame = useCallback((pcm16: Int16Array) => {
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
  }, []);

  const playPcmBase64 = useCallback(async (b64: string, mimeType: string) => {
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
  }, []);

  const handleToolCalls = useCallback(
    async (ws: WebSocket, functionCalls: GeminiFunctionCall[]) => {
      const functionResponses = await Promise.all(
        functionCalls.map(async (fc) => {
          const id = fc.id || `${Date.now()}-${Math.random()}`;
          const name = fc.name || "";
          try {
            if (!name) throw new Error("Tool call missing name.");
            log("info", `[tool] ${name}…`);
            const output = await runGeminiTool(name, fc.args);
            return { id, name, response: { output } };
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            log("warn", `[tool] ${name || "(unknown)"} failed: ${message}`);
            return { id, name, response: { error: message } };
          }
        })
      );

      ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
    },
    [log]
  );

  const handleMessage = useCallback(
    async (evt: MessageEvent) => {
      const ws = wsRef.current;
      if (!ws) return;

      try {
        const data =
          typeof evt.data === "string" ? evt.data : await (evt.data as Blob).text();
        const msg = JSON.parse(data) as unknown;

        const stopSession = async (reason: string) => {
          log("info", `[stop] ${reason}`);

          try {
            const curWs = wsRef.current;
            if (curWs && curWs.readyState === WebSocket.OPEN) {
              curWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
              curWs.close(1000, "Client stop sequence hit");
            }
          } catch {}

          await fullCleanup();
        };

        const functionCalls = extractFunctionCalls(msg);
        if (functionCalls?.length) {
          await handleToolCalls(ws, functionCalls);
          return;
        }

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
          setInputTranscript(inputText);
          log("info", `[ME] ${inputText}`);

          if (stopSequenceRegexRef.current.test(inputText)) {
            await stopSession(`User said stop sequence ("${STOP_SEQUENCES.join(", ")}")`);
            return;
          }
        }

        const outputText = readFirstString(msg, [
          ["outputTranscription", "text"],
          ["output_transcription", "text"],
          ["serverContent", "outputTranscription", "text"],
          ["serverContent", "output_transcription", "text"],
          ["server_content", "outputTranscription", "text"],
          ["server_content", "output_transcription", "text"],
        ]);
        if (outputText && outputText !== lastOutputTranscriptRef.current) {
          log("info", `[ARI] ${outputText}`);

          const prev = lastOutputTranscriptRef.current;
          const isContinuation = !prev || outputText.startsWith(prev) || prev.startsWith(outputText);

          if (prev && !isContinuation) {
            const lastStored = outputHistoryRef.current.at(-1);
            if (prev !== lastStored) outputHistoryRef.current.push(prev);
          }

          lastOutputTranscriptRef.current = outputText;

          const history = outputHistoryRef.current.join("\n\n");
          setOutputTranscript(history ? `${history}\n\n${outputText}` : outputText);

          if (stopSequenceRegexRef.current.test(outputText)) {
            await stopSession(`AI said stop sequence ("${STOP_SEQUENCES.join(", ")}")`);
            return;
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = msg as any;
        if (m.serverContent?.modelTurn?.parts?.length) {
          if (!outputText) {
            const combined = m.serverContent.modelTurn.parts
              .map((p: unknown) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const t = (p as any)?.text;
                return typeof t === "string" ? t : "";
              })
              .join("")
              .trim();

            if (combined && combined !== lastOutputTranscriptRef.current) {
              const prev = lastOutputTranscriptRef.current;
              const isContinuation = !prev || combined.startsWith(prev) || prev.startsWith(combined);
              if (prev && !isContinuation) {
                const lastStored = outputHistoryRef.current.at(-1);
                if (prev !== lastStored) outputHistoryRef.current.push(prev);
              }

              lastOutputTranscriptRef.current = combined;
              const history = outputHistoryRef.current.join("\n\n");
              setOutputTranscript(history ? `${history}\n\n${combined}` : combined);
            }
          }

          for (const part of m.serverContent.modelTurn.parts) {
            const inline =
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (part as any).inlineData ??
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (part as any).inline_data ??
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (part as any).inline_data?.inlineData ??
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (part as any).inlineData;

            if (inline?.data && inline?.mimeType) {
              const mime: string = inline.mimeType;
              if (mime.startsWith("audio/pcm")) {
                await playPcmBase64(inline.data, mime);
              }
            }
          }
        }

        if (m.serverContent?.interrupted) {
          log("info", "Model interrupted (barge-in).");
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        log("error", `Failed to parse message: ${message}`);
      }
    },
    [fullCleanup, handleToolCalls, log, playPcmBase64]
  );

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
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
              }, // Orus
              thinkingConfig: { thinkingBudget: 1 },
            },
            tools: [
              { google_search: {} },
              {
                function_declarations: [
                  ...MAPS_FUNCTION_DECLARATIONS,
                  // ...WEB_FUNCTION_DECLARATIONS, // web_search using serper.dev
                ],
              },
            ],
            tool_config: {
              function_calling_config: { mode: "AUTO" },
            },
            input_audio_transcription: {},
            output_audio_transcription: {},
            system_instruction: {
              role: "system",
              parts: [
                {
                  text: DEFAULT_SYSTEM_INSTRUCTION_TEXT,
                },
              ],
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

      ws.onmessage = (evt) => {
        void handleMessage(evt);
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("error", message);
      cleanupWs();
    }
  }, [cleanupWs, handleMessage, log]);

  useEffect(() => {
    if (!autoConnect) return;
    void connect();
  }, [autoConnect, connect]);

  const disconnect = useCallback(async () => {
    await fullCleanup();
    log("info", "Disconnected.");
  }, [fullCleanup, log]);

  const startMic = useCallback(async () => {
    if (!connected) {
      log("warn", "Connect first.");
      return;
    }
    if (streaming) {
      log("info", "Mic already streaming.");
      return;
    }

    if (!playCtxRef.current) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx({ sampleRate: RECEIVE_SAMPLE_RATE });
      playCtxRef.current = ctx;
      playTimeRef.current = ctx.currentTime;
    }

    try {
      if (playCtxRef.current?.state === "suspended") {
        await playCtxRef.current.resume();
      }

      const greeting = getBossGreeting();
      log("info", `[ME] (greet) ${greeting}`);
      sendUserText(`Say exactly one short greeting sentence to me in a warm tone: "${greeting}"`);

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

        const resampled = resampleFloat32(floatChunk, audioCtx.sampleRate, SEND_SAMPLE_RATE);

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
  }, [cleanupAudio, connected, log, sendAudioFrame, sendUserText, streaming]);

  const stopMic = useCallback(async () => {
    await cleanupAudio();

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    }

    log("info", "Mic streaming stopped.");
  }, [cleanupAudio, log]);

  return {
    connected,
    streaming,
    inputTranscript,
    outputTranscript,
    logs,
    clearLogs,
    connect,
    disconnect,
    startMic,
    stopMic,
  };
}


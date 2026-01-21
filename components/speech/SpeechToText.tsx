"use client";

import React, { useEffect, useRef, useState } from "react";
import VoiceWave from "./VoiceWave";
import { TbRobot } from "react-icons/tb";
import { BiUser } from "react-icons/bi";

const SILENCE_RESET_MS = 1000;
const RESTART_DELAY_MS = 250;
const PIPELINE_DEBOUNCE_MS = 900;
const FATAL_ERRORS = new Set([
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "network",
]);

// --- Web Speech API typing (minimal but safe) ---
declare global {
  type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

  interface SpeechRecognitionResultAlternativeLike {
    transcript: string;
    confidence: number;
  }

  interface SpeechRecognitionResultLike
    extends ArrayLike<SpeechRecognitionResultAlternativeLike> {
    isFinal: boolean;
  }

  interface SpeechRecognitionEventLike {
    results: ArrayLike<SpeechRecognitionResultLike>;
    resultIndex: number;
  }

  interface SpeechRecognitionErrorEventLike {
    error: string;
    message?: string;
  }

  interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
  }

  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

// --- API response type from /api/stt ---
type SpeechPipelineResponse = {
  transcript: string;
  replyText: string;
  audioBase64: string;
  format: "mp3" | "wav";
};

function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export default function SpeechToText() {
  // ---- recognition refs ----
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldBeListeningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pipelineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");

  // ---- audio refs ----
  const lastSentTranscriptRef = useRef<string>(""); // avoid duplicate calls
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteGainRef = useRef<GainNode | null>(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // ---- WebRTC (OpenAI Realtime) refs/state ----
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const [realtimeEnabled, setRealtimeEnabled] = useState(true);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);

  // ---- UI state ----
  const [supported, setSupported] = useState(true);
  const [desiredListening, setDesiredListening] = useState(false);
  const [engineActive, setEngineActive] = useState(false);

  const [text, setText] = useState("");
  const [interimText, setInterimText] = useState("");

  const [status, setStatus] = useState<
    "idle" | "listening" | "thinking" | "ready" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const [replyText, setReplyText] = useState("");
  const [replyAudioBuffer, setReplyAudioBuffer] = useState<AudioBuffer | null>(
    null
  );
  const [audioDecodeError, setAudioDecodeError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const clearRestartTimer = () => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  };

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const clearPipelineTimer = () => {
    if (pipelineTimerRef.current) {
      clearTimeout(pipelineTimerRef.current);
      pipelineTimerRef.current = null;
    }
  };

  const stopPlayback = React.useCallback(() => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // ignore stop races
      }
      try {
        audioSourceRef.current.disconnect();
      } catch {
        // ignore disconnect races
      }
      audioSourceRef.current = null;
    }

    // For realtime (WebRTC), "stop" means mute the remote audio track(s).
    const pc = pcRef.current;
    if (pc) {
      for (const receiver of pc.getReceivers()) {
        if (receiver.track && receiver.track.kind === "audio") {
          receiver.track.enabled = false;
        }
      }
      try {
        if (remoteGainRef.current) remoteGainRef.current.gain.value = 0;
      } catch {
        // ignore
      }
    }
    setIsPlaying(false);
  }, []);

  const cleanupAudio = React.useCallback(() => {
    stopPlayback();
    setReplyAudioBuffer(null);
    setAudioDecodeError(null);
  }, [stopPlayback]);

  const detachRemoteAudioGraph = React.useCallback(() => {
    try {
      remoteStreamSourceRef.current?.disconnect();
    } catch {
      // ignore
    }
    try {
      remoteGainRef.current?.disconnect();
    } catch {
      // ignore
    }
    remoteStreamSourceRef.current = null;
    remoteGainRef.current = null;
    remoteStreamRef.current = null;
  }, []);

  // Mobile browsers require a user gesture before audio playback is allowed.
  // This "unlocks" audio on the user's tap.
  const unlockAudio = React.useCallback(async () => {
    if (audioUnlocked) return;
    if (typeof window === "undefined") return;
    if (!window.AudioContext) return; // older Safari will still allow <audio> controls

    try {
      const ctx = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();

      // Make a tiny silent sound to satisfy gesture-based policies.
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);

      setAudioUnlocked(true);
    } catch {
      // If unlocking fails, we still render native controls as fallback.
    }
  }, [audioUnlocked]);

  const playRealtime = React.useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }
    for (const receiver of pc.getReceivers()) {
      if (receiver.track && receiver.track.kind === "audio") {
        receiver.track.enabled = true;
      }
    }
    try {
      if (remoteGainRef.current) remoteGainRef.current.gain.value = 1;
    } catch {
      // ignore
    }
    setIsPlaying(true);
  }, []);

  const playReply = React.useCallback(async () => {
    if (realtimeEnabled && realtimeConnected) {
      await playRealtime();
      return;
    }
    if (!replyAudioBuffer) return;
    const ctx = audioContextRef.current;
    if (!ctx) return;

    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      // ignore resume failures; user can retry
    }

    stopPlayback();

    const source = ctx.createBufferSource();
    source.buffer = replyAudioBuffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (audioSourceRef.current === source) audioSourceRef.current = null;
      setIsPlaying(false);
    };

    audioSourceRef.current = source;
    setIsPlaying(true);

    try {
      source.start(0);
    } catch {
      setIsPlaying(false);
    }
  }, [replyAudioBuffer, stopPlayback]);

  const ensureRealtimeConnection = React.useCallback(async () => {
    if (!realtimeEnabled) return;

    const existing = pcRef.current;
    if (existing && existing.connectionState !== "closed") return;

    setRealtimeError(null);
    setRealtimeConnected(false);

    // Ensure AudioContext exists so we can attach remote audio to it.
    const ctx =
      audioContextRef.current ??
      (typeof window !== "undefined" && window.AudioContext
        ? new AudioContext()
        : null);
    audioContextRef.current = ctx;

    if (!ctx) {
      setRealtimeError("AudioContext not supported in this browser");
      return;
    }

    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      // iOS may still require a user gesture; unlockAudio() should handle it.
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    pcRef.current = pc;

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setRealtimeConnected(state === "connected");
      if (state === "failed" || state === "disconnected") {
        setRealtimeError(`Realtime connection ${state}`);
      }
    };

    pc.ontrack = (event) => {
      const stream =
        event.streams?.[0] ??
        new MediaStream(event.track ? [event.track] : []);

      remoteStreamRef.current = stream;

      // Build: MediaStream -> AudioContext graph
      detachRemoteAudioGraph();
      try {
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        gain.gain.value = 1;
        src.connect(gain);
        gain.connect(ctx.destination);
        remoteStreamSourceRef.current = src;
        remoteGainRef.current = gain;
        setIsPlaying(true);
      } catch (e) {
        setRealtimeError(e instanceof Error ? e.message : "Audio graph failed");
      }
    };

    // Receive audio from the model.
    pc.addTransceiver("audio", { direction: "recvonly" });

    // Data channel for events / text.
    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;

    dc.onopen = () => {
      setRealtimeError(null);
    };

    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
        const type = (msg.type as string | undefined) ?? "";

        // Best-effort handling across different event type names.
        if (type.includes("text") && type.endsWith(".delta")) {
          const delta = (msg.delta as string | undefined) ?? "";
          if (delta) setReplyText((prev) => `${prev}${delta}`);
        }

        if (type.endsWith("response.completed") || type.endsWith("response.done")) {
          setStatus("ready");
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Some browsers (notably iOS Safari) can yield an incomplete SDP until
    // localDescription is set and ICE gathering has started.
    const waitForIce = () =>
      new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const onStateChange = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", onStateChange);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", onStateChange);
        // Don't block forever; OpenAI can work without full candidates in many cases.
        setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", onStateChange);
          resolve();
        }, 1500);
      });

    await waitForIce();

    const localSdp = pc.localDescription?.sdp?.trim() ?? "";
    if (!localSdp) {
      throw new Error("WebRTC offer SDP is empty (try again after a user tap)");
    }

    const resp = await fetch("/api/realtime/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: localSdp,
        model: "gpt-realtime",
        voice: "alloy",
      }),
    });

    const data = (await resp.json()) as { sdpAnswer?: string; error?: string };
    if (!resp.ok || !data.sdpAnswer) {
      throw new Error(data.error || "Failed to create realtime call");
    }

    await pc.setRemoteDescription({ type: "answer", sdp: data.sdpAnswer });
  }, [detachRemoteAudioGraph, realtimeEnabled]);

  const armSilenceResetTimer = () => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      if (!shouldBeListeningRef.current) return;
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      setText("");
      setInterimText("");
      // Note: we do NOT clear reply/audio here. Only the live transcript display.
    }, SILENCE_RESET_MS);
  };

  const ensureRecognition = (): SpeechRecognitionLike | null => {
    if (recognitionRef.current) return recognitionRef.current;
    if (typeof window === "undefined") return null;

    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return null;

    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setEngineActive(true);
      setError(null);
      setStatus("listening");
    };

    recognition.onend = () => {
      setEngineActive(false);
      interimTranscriptRef.current = "";
      setInterimText("");
      clearSilenceTimer();
      clearPipelineTimer();

      // Mobile browsers often stop recognition after short pauses.
      if (!shouldBeListeningRef.current) {
        setStatus("idle");
        return;
      }

      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        if (!shouldBeListeningRef.current) return;
        try {
          recognition.start();
        } catch {
          // ignore start races
        }
      }, RESTART_DELAY_MS);
    };

    recognition.onerror = (e) => {
      setError(e?.error ?? "speech_recognition_error");
      setEngineActive(false);
      interimTranscriptRef.current = "";
      setInterimText("");
      clearSilenceTimer();
      clearRestartTimer();

      if (FATAL_ERRORS.has(e?.error)) {
        shouldBeListeningRef.current = false;
        setDesiredListening(false);
        setStatus("error");
      }
    };

    recognition.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? "";
        if (result.isFinal) finalChunk += transcript;
        else interimChunk += transcript;
      }

      if (finalChunk) {
        finalTranscriptRef.current = (
          finalTranscriptRef.current
            ? `${finalTranscriptRef.current} ${finalChunk}`
            : finalChunk
        ).trim();
        setText(finalTranscriptRef.current);

        // Debounce: send once the user pauses briefly (prevents Gemini 429 bursts).
        clearPipelineTimer();
        pipelineTimerRef.current = setTimeout(() => {
          void sendTranscriptToPipeline(finalTranscriptRef.current);
        }, PIPELINE_DEBOUNCE_MS);
      }

      const nextInterim = interimChunk.trim();
      if (nextInterim !== interimTranscriptRef.current) {
        interimTranscriptRef.current = nextInterim;
        setInterimText(nextInterim);
      }

      armSilenceResetTimer();
    };

    recognitionRef.current = recognition;
    return recognition;
  };

  // --- call your server pipeline (brain -> tts) ---
  const sendTranscriptToPipeline = async (finalTranscript: string) => {
    const trimmed = finalTranscript.trim();
    if (!trimmed) return;

    // Avoid hammering the API on repeated final events with same content.
    if (trimmed === lastSentTranscriptRef.current) return;
    lastSentTranscriptRef.current = trimmed;

    setStatus("thinking");
    setError(null);
    setReplyText("");
    cleanupAudio();

    try {
      // Prefer realtime streaming (WebRTC) when enabled.
      if (realtimeEnabled) {
        await ensureRealtimeConnection();

        const dc = dcRef.current;
        if (!dc || dc.readyState !== "open") {
          throw new Error("Realtime data channel not ready");
        }

        // Create a user message item, then ask for an audio+text response.
        dc.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: trimmed }],
            },
          })
        );
        dc.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
            },
          })
        );

        setStatus("ready");
        return;
      }

      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: trimmed }),
      });

      const data = (await res.json()) as SpeechPipelineResponse & {
        error?: string;
      };

      if (!res.ok) throw new Error(data.error || "Pipeline failed");

      setReplyText(data.replyText);
      setAudioDecodeError(null);

      const ctx =
        audioContextRef.current ??
        (typeof window !== "undefined" && window.AudioContext
          ? new AudioContext()
          : null);
      audioContextRef.current = ctx;

      if (!ctx) {
        setReplyAudioBuffer(null);
        setAudioDecodeError("AudioContext not supported in this browser");
        setStatus("ready");
        return;
      }

      try {
        const arrayBuffer = base64ToArrayBuffer(data.audioBase64);
        // Safari can be picky: pass a fresh ArrayBuffer slice.
        const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
        setReplyAudioBuffer(decoded);
      } catch {
        setReplyAudioBuffer(null);
        setAudioDecodeError("Failed to decode audio");
      }

      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

  // Try autoplay when audio becomes available (may be blocked by browser policy).
  useEffect(() => {
    if (!replyAudioBuffer) return;
    // Only attempt autoplay after the user has interacted at least once.
    if (!audioUnlocked) return;
    void playReply();
  }, [replyAudioBuffer, audioUnlocked, playReply]);

  useEffect(() => {
    const hasApi =
      typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);

    if (!hasApi) {
      setSupported(false);
      return;
    }

    return () => {
      shouldBeListeningRef.current = false;
      clearSilenceTimer();
      clearRestartTimer();
      clearPipelineTimer();
      recognitionRef.current?.abort();
      cleanupAudio();
      detachRemoteAudioGraph();
      try {
        dcRef.current?.close();
      } catch {
        // ignore
      }
      try {
        pcRef.current?.close();
      } catch {
        // ignore
      }
      dcRef.current = null;
      pcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If realtime is turned off, tear down any existing connection.
  useEffect(() => {
    if (realtimeEnabled) return;
    setRealtimeConnected(false);
    setRealtimeError(null);
    detachRemoteAudioGraph();
    try {
      dcRef.current?.close();
    } catch {
      // ignore
    }
    try {
      pcRef.current?.close();
    } catch {
      // ignore
    }
    dcRef.current = null;
    pcRef.current = null;
  }, [detachRemoteAudioGraph, realtimeEnabled]);

  const start = React.useCallback(() => {
    void unlockAudio(); // user gesture happens here (tap/click)
    setDesiredListening(true);
    shouldBeListeningRef.current = true;
    setError(null);
    clearRestartTimer();

    // reset “last sent” so new session can send again
    lastSentTranscriptRef.current = "";

    try {
      const recognition = ensureRecognition();
      recognition?.start();
    } catch {
      // Some browsers throw if start() is called while already started.
    }
    // Establish realtime early so first response can stream immediately.
    if (realtimeEnabled) {
      void ensureRealtimeConnection();
    }
  }, [ensureRealtimeConnection, realtimeEnabled, unlockAudio]);

  const stopListening = React.useCallback(() => {
    setDesiredListening(false);
    shouldBeListeningRef.current = false;
    clearSilenceTimer();
    clearRestartTimer();
    recognitionRef.current?.stop();
    setStatus("idle");
  }, []);

  if (!supported) {
    return <div>Speech recognition not supported in this browser.</div>;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      {realtimeEnabled ? (
        <div className="text-xs opacity-70">
          Realtime:{" "}
          {realtimeConnected ? "connected" : realtimeError ? "error" : "connecting"}
          {realtimeError ? ` (${realtimeError})` : ""}
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-xs opacity-80 select-none">
        <input
          type="checkbox"
          checked={realtimeEnabled}
          onChange={(e) => setRealtimeEnabled(e.target.checked)}
        />
        Use WebRTC Realtime (streaming). Uncheck to use `/api/stt`.
      </label>

      <button
        type="button"
        onClick={desiredListening ? stopListening : start}
        className="cursor-pointer mb-1 rounded-full"
        aria-label={desiredListening ? "Stop listening" : "Start listening"}
      >
        <VoiceWave
          active={engineActive || true}
          color={engineActive ? "#FF9500" : "green"}
          glow
          sensitivity={8}
          size={320}
          className="rounded-full"
        />
      </button>

      <div className="text-sm opacity-80">
        <span className="font-medium">
          {status === "listening"
            ? "Listening"
            : status === "thinking"
            ? "Thinking"
            : status === "ready"
            ? "Ready"
            : status === "error"
            ? "Error"
            : "Idle"}
        </span>
      </div>

      {error ? (
        <div className="text-red-600 text-sm">Error: {error}</div>
      ) : null}

      {(text) && (
        <div className="w-full max-w-2xl bg-gray-100 p-4 rounded-lg min-h-[60px]">
            <div className="flex items-center gap-2">
              <BiUser className="text-xl" />
              <div className="normal-case">{text}</div>
          </div>
        </div>
      )}

      {replyText ? (
        <div className="w-full max-w-2xl bg-gray-100 p-4 rounded-lg">
          <div className="flex items-center gap-2">
              <TbRobot className="text-xl" />
              <div className="normal-case">{replyText}</div>
          </div>

          {replyAudioBuffer ? (
            <div className="w-full mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={isPlaying ? stopPlayback : playReply}
                className="px-3 py-1 rounded-md bg-black text-white text-sm"
              >
                {isPlaying ? "Stop" : "Play"}
              </button>
              {!audioUnlocked ? (
                <span className="text-xs opacity-70">
                  Tap the mic button once to enable audio playback
                </span>
              ) : null}
            </div>
          ) : audioDecodeError ? (
            <div className="w-full mt-2 text-sm text-red-600">
              Audio error: {audioDecodeError}
            </div>
          ) : null}
        </div>
      ) : null}

      
    </div>
  );
}

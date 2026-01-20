"use client";

import React, { useEffect, useRef, useState } from "react";
import VoiceWave from "./VoiceWave";

const SILENCE_RESET_MS = 1000;
const RESTART_DELAY_MS = 250;
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

function base64ToObjectUrl(base64: string, format: "mp3" | "wav") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const mime = format === "wav" ? "audio/wav" : "audio/mpeg";
  const blob = new Blob([bytes], { type: mime });

  return URL.createObjectURL(blob);
}

export default function SpeechToText() {
  // ---- recognition refs ----
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldBeListeningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");

  // ---- audio refs ----
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSentTranscriptRef = useRef<string>(""); // avoid duplicate calls

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
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

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

  const cleanupAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  };

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

        // If you want to trigger when user finishes a sentence,
        // we’ll send on each new final chunk (debounced by lastSentTranscriptRef).
        void sendTranscriptToPipeline(finalTranscriptRef.current);
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

      const url = base64ToObjectUrl(data.audioBase64, data.format);
      setAudioUrl(url);

      const audio = new Audio(url);
      audioRef.current = audio;

      setStatus("ready");

      // autoplay (optional) — remove if you prefer manual play
      try {
        await audio.play();
      } catch {
        // autoplay can be blocked; user can press Play
      }
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  };

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
      recognitionRef.current?.abort();
      cleanupAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = React.useCallback(() => {
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
  }, []);

  const stopListening = React.useCallback(() => {
    setDesiredListening(false);
    shouldBeListeningRef.current = false;
    clearSilenceTimer();
    clearRestartTimer();
    recognitionRef.current?.stop();
    setStatus("idle");
  }, []);

  const play = () => {
    if (!audioRef.current) return;
    void audioRef.current.play();
  };

  const stopAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
  };

  if (!supported) {
    return <div>Speech recognition not supported in this browser.</div>;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4">
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
        Status:{" "}
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

      {(text || interimText) && (
        <div className="w-full max-w-2xl bg-gray-100 p-4 rounded-lg min-h-[60px]">
          <div className="font-medium">Transcript</div>
          <div>
            {text}
            {interimText ? (
              <span className="opacity-60"> {interimText}</span>
            ) : null}
          </div>
        </div>
      )}

      {replyText ? (
        <div className="w-full max-w-2xl bg-gray-100 p-4 rounded-lg">
          <div className="font-medium">Brain reply</div>
          <div>{replyText}</div>
        </div>
      ) : null}

      {audioUrl ? (
        <div className="w-full max-w-2xl space-y-2">
          <div className="flex gap-2 justify-center">
            <button
              className="border rounded px-3 py-2"
              onClick={play}
              disabled={!audioUrl}
            >
              Play
            </button>
            <button
              className="border rounded px-3 py-2"
              onClick={stopAudio}
              disabled={!audioUrl}
            >
              Stop
            </button>
          </div>

          <audio controls src={audioUrl} className="w-full" />
        </div>
      ) : null}
    </div>
  );
}

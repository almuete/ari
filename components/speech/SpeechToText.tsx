"use client";

import React, { useEffect, useRef, useState } from "react";
import VoiceWave from "./VoiceWave";

const SILENCE_RESET_MS = 1000;
const RESTART_DELAY_MS = 250;
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "network"]);

declare global {
  type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

  interface SpeechRecognitionResultAlternativeLike {
    transcript: string;
    confidence: number;
  }

  interface SpeechRecognitionResultLike extends ArrayLike<SpeechRecognitionResultAlternativeLike> {
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

const SpeechToText = () => {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const shouldBeListeningRef = useRef(false);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");

  const [supported, setSupported] = useState(true);
  const [desiredListening, setDesiredListening] = useState(false);
  const [engineActive, setEngineActive] = useState(false);
  const [text, setText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const armSilenceResetTimer = () => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      // If user has been silent for a moment, reset the transcript display.
      // Keep recognition running so the next utterance starts fresh.
      if (!shouldBeListeningRef.current) return;
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      setText("");
      setInterimText("");
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
    };

    recognition.onend = () => {
      setEngineActive(false);
      interimTranscriptRef.current = "";
      setInterimText("");
      clearSilenceTimer();

      // Mobile browsers often stop recognition after short pauses.
      // If the user still wants to listen, auto-restart to keep it smooth.
      if (!shouldBeListeningRef.current) return;
      clearRestartTimer();
      restartTimerRef.current = setTimeout(() => {
        if (!shouldBeListeningRef.current) return;
        try {
          recognition.start();
        } catch {
          // Ignore start races; if it fails consistently, user can tap Start again.
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

      // If permission/network errors happen, don't spin restart loops.
      if (FATAL_ERRORS.has(e?.error)) {
        shouldBeListeningRef.current = false;
        setDesiredListening(false);
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
        finalTranscriptRef.current = (finalTranscriptRef.current
          ? `${finalTranscriptRef.current} ${finalChunk}`
          : finalChunk
        ).trim();
        setText(finalTranscriptRef.current);
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

  useEffect(() => {
    const hasApi =
      typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!hasApi) {
      setSupported(false);
      return;
    }

    return () => {
      shouldBeListeningRef.current = false;
      clearSilenceTimer();
      clearRestartTimer();
      recognitionRef.current?.abort();
    };
  }, []);

  const start = React.useCallback(() => {
    setDesiredListening(true);
    shouldBeListeningRef.current = true;
    setError(null);
    clearRestartTimer();
    try {
      const recognition = ensureRecognition();
      recognition?.start();
    } catch {
      // Some browsers throw if start() is called while already started.
    }
  }, []);

  const stop = React.useCallback(() => {
    setDesiredListening(false);
    shouldBeListeningRef.current = false;
    clearSilenceTimer();
    clearRestartTimer();
    recognitionRef.current?.stop();
  }, []);

  if (!supported) {
    return <div>Speech recognition not supported in this browser.</div>;
  }

  return (
    <div className=" flex flex-col items-center justify-center">
      <button
        type="button"
        onClick={desiredListening ? stop : start}
        className="cursor-pointer mb-3 rounded-full"
      >
        <VoiceWave
          active={engineActive || true}
          color="#FF9500"
          glow
          sensitivity={8}
          size={500}
          className="mb-3 rounded-full"
        />
      </button>

      {error ? <div style={{ color: "crimson", marginBottom: 8 }}>Error: {error}</div> : null}

      <div>
        {(text || interimText) ? (
          <>
            {text}
            {interimText ? <span style={{ opacity: 0.6 }}> {interimText}</span> : null}
          </>
        ) : desiredListening && (
          <span style={{ opacity: 0.7 }}>{engineActive ? "Listening…" : "Starting…"}</span>
        )}
      </div>
    </div>
  );
};

export default SpeechToText;
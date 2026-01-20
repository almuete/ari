// hooks/useTextToSpeech.ts
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioFormat, TTSProvider } from "@/types/tts";
import { ttsClient } from "@/services/client/tts.client";

type Status = "idle" | "loading" | "ready" | "error";

export function useTextToSpeech() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cleanupAudioUrl = useCallback(() => {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const speak = useCallback(
    async (params: {
      text: string;
      provider?: TTSProvider;
      voice?: string;
      format?: AudioFormat;
    }) => {
      cleanupAudioUrl();
      setStatus("loading");
      setError(null);

      try {
        const { audioBase64, format } = await ttsClient({
          text: params.text,
          provider: params.provider,
          voice: params.voice,
          format: params.format,
        });

        const byteChars = atob(audioBase64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);

        const mime =
          format === "wav" ? "audio/wav" : "audio/mpeg";

        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);

        setAudioUrl(url);
        setStatus("ready");
        return { url, format };
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Unknown error");
        throw e;
      }
    },
    [cleanupAudioUrl]
  );

  useEffect(() => {
    const current = audioRef.current;
    if (current) {
      current.pause();
      audioRef.current = null;
    }

    if (!audioUrl) return;
    audioRef.current = new Audio(audioUrl);

    return () => {
      const a = audioRef.current;
      if (a) a.pause();
      audioRef.current = null;
    };
  }, [audioUrl]);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    void audio.play();
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
  }, []);

  return {
    status,
    error,
    audioUrl,
    speak,
    play,
    stop,
    cleanupAudioUrl,
  };
}

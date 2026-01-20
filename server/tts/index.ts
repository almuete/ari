// server/tts/index.ts
import "server-only";
import type { AudioFormat, TTSProvider, TTSResponse } from "@/types/tts";
import { generateOpenAITTS } from "./providers/openai";

export interface TTSOptions {
  provider?: TTSProvider;
  voice?: string;
  format?: AudioFormat;
}

const DEFAULTS = {
  provider: "openai" as const,
  voice: "alloy",
  format: "mp3" as const,
};

export async function textToSpeech(
  text: string,
  options: TTSOptions = {}
): Promise<TTSResponse> {
  const trimmed = text?.trim();
  if (!trimmed) throw new Error("Text is required for TTS");

  const provider = options.provider ?? DEFAULTS.provider;
  const voice = options.voice ?? DEFAULTS.voice;
  const format = options.format ?? DEFAULTS.format;

  switch (provider) {
    case "openai":
      return generateOpenAITTS(trimmed, { voice, format });

    case "google":
      throw new Error("Google TTS not implemented yet");

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported TTS provider: ${_exhaustive}`);
    }
  }
}

// server/tts/index.ts
import "server-only";
import type { AudioFormat, TTSProvider, TTSResponse } from "@/types/tts";
import { generateOpenAITTS } from "./providers/openai";
import { generateGoogleTTS } from "./providers/google";

export interface TTSOptions {
  provider?: TTSProvider;
  voice?: string;
  format?: AudioFormat;
}

const DEFAULTS_OPENAI = {
  provider: "openai" as const,
  voice: "alloy",
  format: "mp3" as const,
};

const DEFAULTS_GEMINI = {
  provider: "google" as const,
  voice: "Kore",
  format: "wav" as const,
};

const DEFAULTS = DEFAULTS_GEMINI; // DEFAULTS_GEMINI || DEFAULTS_OPENAI;

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
      return generateGoogleTTS(trimmed, { voice, format });

    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported TTS provider: ${_exhaustive}`);
    }
  }
}

// server/tts/providers/openai.ts
import "server-only";
import OpenAI from "openai";
import type { AudioFormat, TTSResponse } from "@/types/tts";

let openai: OpenAI | null = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY environment variable");
  openai ??= new OpenAI({ apiKey });
  return openai;
}

export interface OpenAITTSOptions {
  voice: string;
  format: AudioFormat;
}

export async function generateOpenAITTS(
  text: string,
  options: OpenAITTSOptions
): Promise<TTSResponse> {
  const openai = getOpenAIClient();

  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    input: text,
    voice: options.voice,
    response_format: options.format,
  });

  const buffer = Buffer.from(await resp.arrayBuffer());

  return {
    audioBase64: buffer.toString("base64"),
    format: options.format,
  };
}

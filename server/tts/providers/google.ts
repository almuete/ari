// server/tts/providers/google.ts
import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { AudioFormat, TTSResponse } from "@/types/tts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function extractInlineAudioBase64(value: unknown): string {
  if (!isRecord(value)) return "";
  const candidates = value.candidates;
  const candidate = Array.isArray(candidates) ? candidates[0] : null;
  const content = isRecord(candidate) ? candidate.content : null;
  const parts = isRecord(content) ? content.parts : null;
  const part0 = Array.isArray(parts) ? parts[0] : null;
  const inlineData = isRecord(part0) ? part0.inlineData : null;
  const data = isRecord(inlineData) ? inlineData.data : null;
  return typeof data === "string" ? data : "";
}

function pcm16leToWav(
  pcm: Buffer,
  args: { channels?: number; sampleRate?: number; bitsPerSample?: number } = {}
): Buffer {
  const channels = args.channels ?? 1;
  const sampleRate = args.sampleRate ?? 24000;
  const bitsPerSample = args.bitsPerSample ?? 16;

  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(riffSize, 4);
  header.write("WAVE", 8, 4, "ascii");

  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

export interface GoogleTTSOptions {
  voice: string;
  format: AudioFormat;
  model?: string;
}

export async function generateGoogleTTS(
  text: string,
  options: GoogleTTSOptions
): Promise<TTSResponse> {
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing GOOGLE_API_KEY (or legacy GEMINI_API_KEY) environment variable"
    );
  }

  // Per Google Gemini TTS docs, the model returns raw PCM audio; we wrap it in WAV.
  if (options.format !== "wav") {
    throw new Error('Google TTS currently supports only format "wav"');
  }

  const model = options.model ?? "gemini-2.5-flash-preview-tts";
  const ai = new GoogleGenAI({ apiKey });

  let response: unknown;
  try {
    response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: text.trim() }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: options.voice,
            },
          },
        },
      },
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Google request failed (unknown error)";
    throw new Error(message);
  }

  const base64Pcm = extractInlineAudioBase64(response);
  if (!base64Pcm) throw new Error("Google returned empty audio response");

  const pcm = Buffer.from(base64Pcm, "base64");
  const wav = pcm16leToWav(pcm, {
    channels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
  });

  return {
    audioBase64: wav.toString("base64"),
    format: "wav",
  };
}


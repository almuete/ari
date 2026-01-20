// types/tts.ts
export type TTSProvider = "openai" | "google";
export type AudioFormat = "mp3" | "wav";

export interface TTSRequest {
  text: string;
  provider?: TTSProvider;
  voice?: string;
  format?: AudioFormat;
}

export interface TTSResponse {
  audioBase64: string;
  format: AudioFormat;
}

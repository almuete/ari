// services/client/tts.client.ts
import type { TTSRequest, TTSResponse } from "@/types/tts";

export async function ttsClient(payload: TTSRequest): Promise<TTSResponse> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as TTSResponse & { error?: string };

  if (!res.ok) {
    throw new Error(data.error || "TTS request failed");
  }

  return data;
}

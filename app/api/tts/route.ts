// app/api/tts/route.ts
import { NextResponse } from "next/server";
import { textToSpeech } from "@/server/tts";
import type { TTSRequest, TTSResponse } from "@/types/tts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<TTSRequest>;

    if (!body.text || !body.text.trim()) {
      return NextResponse.json(
        { error: "text is required" },
        { status: 400 }
      );
    }

    const result: TTSResponse = await textToSpeech(body.text, {
      provider: body.provider,
      voice: body.voice,
      format: body.format,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

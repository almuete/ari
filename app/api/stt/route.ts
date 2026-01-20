import { NextResponse } from "next/server";
import { brain } from "@/server/brain";
import { textToSpeech } from "@/server/tts";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { transcript, brainProvider, brainModel } = await req.json();

    if (!transcript || !transcript.trim()) {
      return NextResponse.json({ error: "transcript is required" }, { status: 400 });
    }

    const replyText = await brain(
      { transcript },
      { provider: brainProvider, model: brainModel }
    );
    const audio = await textToSpeech(replyText, { provider: "openai" });

    return NextResponse.json({
      transcript,
      replyText,
      ...audio, // { audioBase64, format }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
